import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { CredentialStore } from "../credential-store.js";
import { ProviderAccountManager } from "../provider-account-manager.js";
import { readSessionAccountMarker } from "../session-credentials.js";
import { RepoStore } from "../repo-store.js";
import { GitManager } from "../../shared/git.js";
import { createHeadlessSession, seedFromIssueRef } from "./headless-sessions.js";
import type { GraduateSessionDeps } from "./graduate-session.js";
import { ServiceError } from "./types.js";
import type { ClaimSessionService } from "./claim-session.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { AgentId, AutoMergeState } from "../../shared/types.js";
import type * as InstalledHarnesses from "../../shared/installed-harnesses.js";

type InstalledHarnessesModule = typeof InstalledHarnesses;

/**
 * docs/252 phase 9 (req 14) — which harnesses this "deployment" has. Empty for
 * every other test in this file, so they keep the pre-feature behaviour of
 * "everything in the catalogue is installed".
 */
const uninstalledHarnesses = new Set<string>();
vi.mock("../../shared/installed-harnesses.js", async (importOriginal) => {
  const actual = await importOriginal<InstalledHarnessesModule>();
  return { ...actual, isHarnessInstalled: (id: string) => !uninstalledHarnesses.has(id) };
});

interface FakeRunner {
  running: boolean;
  dispatch: ReturnType<typeof vi.fn>;
}

class FakeRunnerRegistry {
  runners = new Map<string, FakeRunner>();
  created: { sessionId: string; workspaceDir: string; agentId: AgentId }[] = [];

  get(sessionId: string): FakeRunner | undefined {
    return this.runners.get(sessionId);
  }

  getOrCreate(sessionId: string, workspaceDir: string, agentId: AgentId): FakeRunner {
    const existing = this.runners.get(sessionId);
    if (existing) return existing;
    const runner = { running: true, dispatch: vi.fn() };
    this.runners.set(sessionId, runner);
    this.created.push({ sessionId, workspaceDir, agentId });
    return runner;
  }
}

function initWorkspace(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  execSync(
    "git add README.md && git -c user.email=test@test.com -c user.name=Test commit -m init --no-gpg-sign",
    { cwd: dir, stdio: "ignore" },
  );
}


/**
 * docs/248 req 22 — the pushed branch name must never carry the issue title.
 *
 * A branch is pushed to a public remote, so a title from a private planning
 * issue would be published there. The rule is unconditional: ShipIt has no
 * signal for which repositories are private (a declared planning repo may be
 * public; a session's own code repo may be private), so a rule scoped to
 * "private" issues would be a guess. These cover the pointer shapes a seed can
 * arrive with.
 */
describe("seedFromIssueRef — branch names carry the pointer only", () => {
  it("omits a Linear issue title from the branch", () => {
    const seed = seedFromIssueRef({
      tracker: "linear",
      identifier: "SHI-304",
      title: "Acquire competitor before Q3 board meeting",
    });
    expect(seed.branch).toBe("shi-304");
    expect(seed.branch).not.toMatch(/acquire|competitor|board/);
  });

  it("omits a GitHub issue title from the branch, keeping the qualified pointer", () => {
    const seed = seedFromIssueRef({
      tracker: "github:acme/planning",
      identifier: "acme/planning#42",
      title: "Secret roadmap item",
    });
    expect(seed.branch).toBe("acme-planning-42");
    expect(seed.branch).not.toMatch(/secret|roadmap/);
  });

  it("keeps the title in the session title and seed prompt — both stay inside ShipIt", () => {
    const seed = seedFromIssueRef({
      tracker: "linear",
      identifier: "SHI-304",
      title: "Secret plan",
      description: "Details",
    });
    expect(seed.title).toBe("SHI-304: Secret plan");
    expect(seed.prompt).toContain("Secret plan");
  });

  // The seed is a POINTER, not a copy: the description used to be pasted in
  // wholesale, which buried whatever the user appended in the composer and
  // froze a body the agent can read live. It fetches instead.
  it("names the issue without pasting its description or link", () => {
    const seed = seedFromIssueRef({
      tracker: "linear",
      identifier: "SHI-304",
      title: "Secret plan",
      description: "A long body the agent should fetch itself.",
      url: "https://linear.app/acme/issue/SHI-304",
    });
    expect(seed.prompt).toContain("Work on issue SHI-304: Secret plan");
    expect(seed.prompt).toContain("shipit issue view SHI-304");
    expect(seed.prompt).not.toContain("A long body");
    expect(seed.prompt).not.toContain("https://linear.app");
  });

  it("falls back to a generated branch when the pointer slugifies to nothing", () => {
    const seed = seedFromIssueRef({ tracker: "linear", identifier: "###", title: "T" });
    expect(seed.branch).not.toBe("");
    expect(seed.branch).not.toContain("#");
  });

  it("stays a pure function of the issue, so collisions are unchanged", () => {
    const ref = { tracker: "linear" as const, identifier: "SHI-1", title: "A" };
    expect(seedFromIssueRef(ref).branch).toBe(seedFromIssueRef({ ...ref, title: "B" }).branch);
  });
});

describe("createHeadlessSession", () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  let repoStore: RepoStore;
  let registry: FakeRunnerRegistry;
  let nextSession = 0;
  let graduationDeps: GraduateSessionDeps;
  /**
   * `migrateDefaultAccounts` refuses to run when `SHIPIT_SESSION_ID` is set —
   * inside a session container `credentialsDir` is the live agent home, not the
   * orchestrator's credentials volume. That var is genuinely set whenever this
   * suite runs inside ShipIt (dogfooding), so the credential-routing test below
   * migrated nothing and failed on the *host it ran on* rather than on the
   * code. CI leaves it unset, so this only ever broke the in-box run. Same
   * treatment as `provider-account-manager.test.ts`: pin it off, restore after.
   */
  let savedSessionId: string | undefined;

  beforeEach(() => {
    savedSessionId = process.env.SHIPIT_SESSION_ID;
    delete process.env.SHIPIT_SESSION_ID;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-headless-svc-"));
    dbManager = new DatabaseManager(":memory:");
    sessionManager = new SessionManager(dbManager);
    repoStore = new RepoStore(dbManager);
    registry = new FakeRunnerRegistry();
    nextSession = 0;
    graduationDeps = {
      sessionManager,
      runnerRegistry: registry as unknown as SessionRunnerRegistry,
      repoStore,
      createGitManager: (dir: string) => new GitManager(dir),
      prStatusPoller: { getStatus: vi.fn(() => undefined) } as unknown as PrStatusPoller,
      sseBroadcast: vi.fn(),
    };
  });

  afterEach(() => {
    uninstalledHarnesses.clear();
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedSessionId === undefined) delete process.env.SHIPIT_SESSION_ID;
    else process.env.SHIPIT_SESSION_ID = savedSessionId;
  });

  // Minimal stand-ins for the auto-merge arm path (docs/175). `toggleAutoMerge`
  // with no PR present (getStatus → undefined) falls through to
  // `setAutoMergeEnabled`, so we only need those two methods plus an in-memory
  // state map to observe the seeded armed state.
  function fakeAutoMergePoller(): {
    poller: PrStatusPoller;
    states: Map<string, AutoMergeState>;
    setEnabled: ReturnType<typeof vi.fn>;
  } {
    const states = new Map<string, AutoMergeState>();
    const setEnabled = vi.fn((sessionId: string, enabled: boolean): AutoMergeState => {
      const state: AutoMergeState = { enabled, mergeMethod: "squash" };
      states.set(sessionId, state);
      return state;
    });
    const poller = {
      getStatus: vi.fn(() => undefined),
      getAutoMergeState: vi.fn((sessionId: string) => states.get(sessionId)),
      setAutoMergeEnabled: setEnabled,
    } as unknown as PrStatusPoller;
    return { poller, states, setEnabled };
  }

  const authedGitHub = { authenticated: true } as unknown as GitHubAuthManager;

  function claimService(opts: { reusedRunner?: FakeRunner; fail?: Error } = {}): ClaimSessionService {
    return {
      claim: vi.fn(async (repoUrl: string) => {
        if (opts.fail) throw opts.fail;
        nextSession += 1;
        const sessionId = `quick-${nextSession}`;
        const workspaceDir = path.join(tmpDir, sessionId, "workspace");
        initWorkspace(workspaceDir);
        sessionManager.track(sessionId, "Warm session", workspaceDir);
        sessionManager.setRemoteUrl(sessionId, repoUrl);
        sessionManager.setWarm(sessionId, true);
        if (opts.reusedRunner) registry.runners.set(sessionId, opts.reusedRunner);
        return { sessionId, workspaceDir, fetchDurationMs: 0, claimPath: "slow-clone" as const };
      }),
    };
  }

  it("claims a workspace, starts the runner with the prompt, and returns the session", async () => {
    const result = await createHeadlessSession(
      sessionManager,
      registry as unknown as SessionRunnerRegistry,
      claimService(),
      {
        repoUrl: "https://github.com/acme/app.git",
        prompt: "  Fix the failing tests  ",
        branch: "quick-tests",
        agent: "codex",
        model: "gpt-5.4",
      },
      "claude",
      undefined,
      undefined,
      undefined,
      graduationDeps,
    );

    expect(result.sessionId).toBe("quick-1");
    expect(result.branch).toBe("quick-tests");
    expect(result.session).toMatchObject({
      id: "quick-1",
      title: "Fix the failing tests",
      branch: "quick-tests",
      branchRenamed: true,
      model: "gpt-5.4",
    });
    const persisted = sessionManager.get("quick-1");
    expect(persisted).toMatchObject({
      agentId: "codex",
      agentPinned: true,
    });
    expect(persisted?.warm).toBeUndefined();
    expect(registry.created).toEqual([{
      sessionId: "quick-1",
      workspaceDir: path.join(tmpDir, "quick-1", "workspace"),
      agentId: "codex",
    }]);
    expect(registry.get("quick-1")?.dispatch).toHaveBeenCalledWith({ text: "Fix the failing tests" });
    expect(execSync("git branch --show-current", {
      cwd: path.join(tmpDir, "quick-1", "workspace"),
      encoding: "utf8",
    }).trim()).toBe("quick-tests");
  });

  // docs/252 phase 9 (req 14) — Quick Capture is the one turn-dispatching path
  // that does not go through `agentAdmissionError`: it dispatches straight onto
  // the runner. Its agent comes from a catalogue-wide model lookup or from
  // caller-supplied text, so a stale browser selection can name a harness this
  // deployment does not have — and the pin is write-once.
  it("falls back to the install's default agent when the requested one is not installed", async () => {
    uninstalledHarnesses.add("claude");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await createHeadlessSession(
      sessionManager,
      registry as unknown as SessionRunnerRegistry,
      claimService(),
      {
        repoUrl: "https://github.com/acme/app.git",
        prompt: "stale selection",
        agent: "claude",
      },
      "codex",
      undefined,
      undefined,
      undefined,
      graduationDeps,
    );

    expect(sessionManager.get("quick-1")).toMatchObject({ agentId: "codex", agentPinned: true });
    expect(registry.created).toEqual([expect.objectContaining({ agentId: "codex" })]);
    // planning#389 — this substitution stays a substitution, and stays audible.
    // It is a different question from the style check below: the harness COULD
    // run the model, this deployment just doesn't ship it, and the user cannot
    // re-aim a quick capture from where they are.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("is not installed in this deployment"));
    warn.mockRestore();
  });

  it("still honours a requested agent the deployment does have", async () => {
    uninstalledHarnesses.add("codex");

    await createHeadlessSession(
      sessionManager,
      registry as unknown as SessionRunnerRegistry,
      claimService(),
      {
        repoUrl: "https://github.com/acme/app.git",
        prompt: "deliberate pick",
        agent: "claude",
      },
      "claude",
      undefined,
      undefined,
      undefined,
      graduationDeps,
    );

    expect(sessionManager.get("quick-1")).toMatchObject({ agentId: "claude" });
  });

  // planning#389 — the four cases the harness/model pair can be in. Only the
  // second is a refusal; the other three are the behaviours docs/166 and
  // planning#304 settled, and they are asserted here so a future edit cannot
  // widen the refusal into them.
  describe("an explicit harness that disagrees with the model", () => {
    it("refuses when the harness cannot speak the model's API style", async () => {
      const service = claimService();

      await expect(createHeadlessSession(
        sessionManager,
        registry as unknown as SessionRunnerRegistry,
        service,
        {
          repoUrl: "https://github.com/acme/app.git",
          prompt: "Run this on Codex",
          // `claude-opus-5` declares anthropic-messages only; Codex speaks
          // neither of that model's styles. Rerouting this to Claude ran and
          // BILLED four sessions the callers never asked for.
          agent: "codex",
          model: "claude-opus-5",
          serviceId: "anthropic",
          billingMode: "sub",
        },
        "claude",
        undefined,
        undefined,
        undefined,
        graduationDeps,
      )).rejects.toMatchObject({
        statusCode: 400,
        message: "Codex cannot run Opus 5 — they share no API style. "
          + "Choose a model Codex can run, or run Opus 5 on Claude Code.",
      });

      // Refused before any side effect: no warm session claimed, no runner, no
      // session row, and above all no turn dispatched onto the other harness.
      expect(service.claim).not.toHaveBeenCalled();
      expect(registry.created).toEqual([]);
      expect(sessionManager.list()).toEqual([]);
    });

    it("still derives the harness from the model when the caller named none (docs/166)", async () => {
      await createHeadlessSession(
        sessionManager,
        registry as unknown as SessionRunnerRegistry,
        claimService(),
        {
          repoUrl: "https://github.com/acme/app.git",
          prompt: "no harness named",
          model: "claude-opus-5",
        },
        "codex",
        undefined,
        undefined,
        undefined,
        graduationDeps,
      );

      // The model is the source of truth, and with nothing to contradict there
      // is nothing to refuse — it beats the install default, exactly as before.
      expect(sessionManager.get("quick-1")).toMatchObject({ agentId: "claude", agentPinned: true });
    });

    it("honours a harness that shares the model with the other one (planning#304)", async () => {
      await createHeadlessSession(
        sessionManager,
        registry as unknown as SessionRunnerRegistry,
        claimService(),
        {
          repoUrl: "https://github.com/acme/app.git",
          prompt: "shared model",
          // Both harnesses list `deepseek-v4-pro`, so this is not a disagreement
          // at all — `agentIdForModel` merely answers with whichever sorts first.
          agent: "codex",
          model: "deepseek-v4-pro",
        },
        "claude",
        undefined,
        undefined,
        undefined,
        graduationDeps,
      );

      expect(sessionManager.get("quick-1")).toMatchObject({ agentId: "codex", agentPinned: true });
    });

    it("passes through a model id no harness lists, keeping the named harness", async () => {
      await createHeadlessSession(
        sessionManager,
        registry as unknown as SessionRunnerRegistry,
        claimService(),
        {
          repoUrl: "https://github.com/acme/app.git",
          prompt: "forward compat",
          // A versioned or newer id the catalogue hasn't surfaced yet. Nothing
          // says the pair is incoherent, so refusing it would break the same
          // forward-compat the child-session and role validators keep.
          agent: "codex",
          model: "gpt-5.7-not-in-the-catalogue-yet",
        },
        "claude",
        undefined,
        undefined,
        undefined,
        graduationDeps,
      );

      expect(sessionManager.get("quick-1")).toMatchObject({ agentId: "codex", agentPinned: true });
    });

    it("does not describe an unknown agent id as an API-style mismatch", async () => {
      await createHeadlessSession(
        sessionManager,
        registry as unknown as SessionRunnerRegistry,
        claimService(),
        {
          repoUrl: "https://github.com/acme/app.git",
          prompt: "unknown harness",
          // Free text off the wire — the route casts it without checking. The
          // refusal speaks about API styles, which says nothing true about an id
          // no harness has, so this keeps falling through to the model's harness.
          agent: "gemini" as AgentId,
          model: "claude-opus-5",
        },
        "claude",
        undefined,
        undefined,
        undefined,
        graduationDeps,
      );

      expect(sessionManager.get("quick-1")).toMatchObject({ agentId: "claude" });
    });
  });

  it("persists a valid reasoning effort on the session row before the first turn", async () => {
    // docs/217 — the quick session's first turn is dispatched server-side, so
    // the chosen reasoning must land on the row (graduateSession) before the
    // dispatched turn reads it. "high" is valid for both Claude and Codex.
    await createHeadlessSession(
      sessionManager,
      registry as unknown as SessionRunnerRegistry,
      claimService(),
      {
        repoUrl: "https://github.com/acme/app.git",
        prompt: "reason hard",
        agent: "claude",
        reasoning: "high",
      },
      "claude",
      undefined,
      undefined,
      undefined,
      graduationDeps,
    );

    expect(sessionManager.get("quick-1")?.reasoningEffort).toBe("high");
  });

  it("drops a reasoning effort that isn't valid for the resolved agent", async () => {
    // "max" is a Claude-only level; with a Codex model the agent resolves to
    // codex, whose options stop at xhigh — so it must be ignored, not pinned.
    await createHeadlessSession(
      sessionManager,
      registry as unknown as SessionRunnerRegistry,
      claimService(),
      {
        repoUrl: "https://github.com/acme/app.git",
        prompt: "reason hard",
        model: "gpt-5.4",
        reasoning: "max",
      },
      "claude",
      undefined,
      undefined,
      undefined,
      graduationDeps,
    );

    expect(sessionManager.get("quick-1")?.agentId).toBe("codex");
    expect(sessionManager.get("quick-1")?.reasoningEffort).toBeUndefined();
  });

  it("uses an existing warm runner when the registry already has one", async () => {
    const reusedRunner = { running: true, dispatch: vi.fn() };

    const result = await createHeadlessSession(
      sessionManager,
      registry as unknown as SessionRunnerRegistry,
      claimService({ reusedRunner }),
      {
        repoUrl: "https://github.com/acme/app.git",
        prompt: "use the warm runner",
      },
      "claude",
      undefined,
      undefined,
      undefined,
      graduationDeps,
    );

    expect(result.sessionId).toBe("quick-1");
    expect(registry.created).toEqual([]);
    expect(reusedRunner.dispatch).toHaveBeenCalledWith({ text: "use the warm runner" });
  });

  it("rejects invalid input before claiming a workspace", async () => {
    const claim = claimService();
    await expect(createHeadlessSession(
      sessionManager,
      registry as unknown as SessionRunnerRegistry,
      claim,
      { repoUrl: "", prompt: "do it" },
      "claude",
      undefined,
      undefined,
      undefined,
      graduationDeps,
    )).rejects.toMatchObject({ statusCode: 400, message: "Add a repo first." });

    await expect(createHeadlessSession(
      sessionManager,
      registry as unknown as SessionRunnerRegistry,
      claim,
      { repoUrl: "https://github.com/acme/app.git", prompt: "   " },
      "claude",
      undefined,
      undefined,
      undefined,
      graduationDeps,
    )).rejects.toMatchObject({ statusCode: 400, message: "prompt is required" });

    expect(claim.claim).not.toHaveBeenCalled();
  });

  it("keeps env-prep account-neutral: no selection, no provisioning (docs/260 §5b)", async () => {
    // docs/260 removed session→account pinning: headless create's env-prep is
    // now a WARM-UP (`enforceAccountRouting` unset), and warm-ups are
    // account-neutral by design — they select no account, stamp no route, and
    // provision no per-session credential subtree. The real first turn's own
    // pre-spawn env-prep, moments later, is what selects and provisions; a
    // selection here would double-select against it. This test pins that
    // neutrality with connected accounts present for BOTH providers, so a
    // regression back to eager selection has something to select.
    //
    // Real credential files, not bare directories: migration gates on a
    // credential marker having content, because an empty `.claude` is something
    // anything running with `HOME=/root` can create through the image-level
    // symlink and is not evidence of an account.
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".claude", ".credentials.json"), '{"accessToken":"live"}');
    fs.writeFileSync(path.join(tmpDir, ".claude.json"), "{}");
    fs.mkdirSync(path.join(tmpDir, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".codex", "auth.json"), '{"tokens":{"access_token":"live"}}');
    const credentialStore = new CredentialStore(tmpDir);
    const providerAccountManager = new ProviderAccountManager({
      credentialsDir: tmpDir,
      credentialStore,
    });
    providerAccountManager.migrateDefaultAccounts();
    expect(providerAccountManager.getPrimary("anthropic")?.id).toBe("claude-default");
    expect(providerAccountManager.getPrimary("openai")?.id).toBe("codex-default");
    // A resolved selection always stamps usage (docs/150 req 21) — so an
    // untouched spy proves no selection resolved.
    const markUsed = vi.spyOn(providerAccountManager, "markAccountUsed");

    await createHeadlessSession(
      sessionManager,
      registry as unknown as SessionRunnerRegistry,
      claimService(),
      { repoUrl: "https://github.com/acme/app.git", prompt: "do it", agent: "claude" },
      "claude",
      tmpDir,
      credentialStore,
      providerAccountManager,
      graduationDeps,
    );
    // No account selected, no route stamped anywhere: not on the session row,
    // not on the runner, and no per-session credential subtree (whose account
    // marker is provisioning's one durable trace — docs/260 §4).
    expect(markUsed).not.toHaveBeenCalled();
    const claudeSession = sessionManager.get("quick-1");
    expect(claudeSession?.providerRouteKind).toBeUndefined();
    expect(claudeSession?.providerRouteId).toBeUndefined();
    expect((registry.get("quick-1") as { residentRoute?: unknown } | undefined)?.residentRoute)
      .toBeUndefined();
    expect(readSessionAccountMarker(tmpDir, "quick-1")).toEqual({});
    // Neutrality must not stall the session: the first turn still dispatches,
    // and ITS env-prep is what provisions.
    expect(registry.get("quick-1")?.dispatch).toHaveBeenCalledTimes(1);

    await createHeadlessSession(
      sessionManager,
      registry as unknown as SessionRunnerRegistry,
      claimService(),
      { repoUrl: "https://github.com/acme/app.git", prompt: "do it", agent: "codex" },
      "claude",
      tmpDir,
      credentialStore,
      providerAccountManager,
      graduationDeps,
    );
    // Same neutrality for the other harness — the two share the plumbing.
    expect(markUsed).not.toHaveBeenCalled();
    const codexSession = sessionManager.get("quick-2");
    expect(codexSession?.providerRouteKind).toBeUndefined();
    expect(codexSession?.providerRouteId).toBeUndefined();
    expect(readSessionAccountMarker(tmpDir, "quick-2")).toEqual({});
    expect(registry.get("quick-2")?.dispatch).toHaveBeenCalledTimes(1);
  });

  it("defers branchRenamed when no explicit branch/title is pinned", async () => {
    // Structural assertion for the unified-graduation contract (docs/156):
    // when the caller doesn't pin a branch/title, `createHeadlessSession`
    // hands ownership of `branchRenamed` to the shared `graduateSession`
    // flow. The synchronous return therefore leaves `branchRenamed` unset;
    // the async naming chain — driven by the real CLI — flips it once the
    // rename completes. We deliberately do not await that chain here: the
    // cross-flow naming logic is unit-tested in `graduate-session.test.ts`
    // with a mocked CLI.
    const result = await createHeadlessSession(
      sessionManager,
      registry as unknown as SessionRunnerRegistry,
      claimService(),
      {
        repoUrl: "https://github.com/acme/app.git",
        prompt: "Fix the flaky test",
        agent: "claude",
      },
      "claude",
      undefined,
      undefined,
      undefined,
      graduationDeps,
    );

    expect(result.session.title).toBe("Fix the flaky test");
    // generateBranchPrefix → "shipit/<6 base64url chars>" (lowercased).
    expect(result.session.branch).toMatch(/^shipit\/[a-z0-9_-]{1,6}$/);
    expect(result.session.branchRenamed).toBeUndefined();
  });

  it("seeds branch, title, and first prompt from an issueRef (docs/170)", async () => {
    const result = await createHeadlessSession(
      sessionManager,
      registry as unknown as SessionRunnerRegistry,
      claimService(),
      {
        repoUrl: "https://github.com/acme/app.git",
        issueRef: {
          tracker: "linear",
          identifier: "SHI-67",
          title: "Inline tracker Issues tab",
          url: "https://linear.app/acme/issue/SHI-67",
          description: "Build the Issues tab.",
        },
      },
      "claude",
      undefined,
      undefined,
      undefined,
      graduationDeps,
    );

    // docs/248 req 22 — the branch is the POINTER ONLY. A branch gets pushed to a
    // public remote, so the issue title must not appear in it. The session title
    // and the seed prompt still carry it: both stay inside ShipIt.
    expect(result.branch).toBe("shi-67");
    expect(result.branch).not.toContain("inline");
    expect(result.session.title).toBe("SHI-67: Inline tracker Issues tab");
    expect(result.session.branch).toBe("shi-67");
    // The first dispatched prompt names the issue and tells the agent how to
    // read it — it does not carry a copy of the body (see the seed tests above).
    const text = registry.get(result.sessionId)?.dispatch.mock.calls[0][0].text as string;
    expect(text).toContain("SHI-67: Inline tracker Issues tab");
    expect(text).toContain("shipit issue view SHI-67");
    expect(text).not.toContain("Build the Issues tab.");
  });

  it("propagates claim failures as service errors", async () => {
    await expect(createHeadlessSession(
      sessionManager,
      registry as unknown as SessionRunnerRegistry,
      claimService({ fail: new ServiceError(500, "clone failed") }),
      {
        repoUrl: "https://github.com/acme/app.git",
        prompt: "start",
      },
      "claude",
      undefined,
      undefined,
      undefined,
      graduationDeps,
    )).rejects.toMatchObject({ statusCode: 500, message: "clone failed" });
  });

  it("saves uploaded files into the new session's uploads dir and dispatches with UploadRefs", async () => {
    const result = await createHeadlessSession(
      sessionManager,
      registry as unknown as SessionRunnerRegistry,
      claimService(),
      {
        repoUrl: "https://github.com/acme/app.git",
        prompt: "take a look",
        uploads: [
          { filename: "note.txt", data: Buffer.from("hello") },
          { filename: "data.csv", data: Buffer.from("a,b\n1,2") },
        ],
      },
      "claude",
      undefined,
      undefined,
      undefined,
      graduationDeps,
    );

    const sessionDir = path.dirname(path.join(tmpDir, "quick-1", "workspace"));
    const uploadsDir = path.join(sessionDir, "uploads");
    expect(fs.existsSync(path.join(uploadsDir, "note.txt"))).toBe(true);
    expect(fs.existsSync(path.join(uploadsDir, "data.csv"))).toBe(true);
    expect(fs.readFileSync(path.join(uploadsDir, "note.txt"), "utf8")).toBe("hello");

    const dispatchCall = registry.get(result.sessionId)?.dispatch.mock.calls[0][0] as {
      text: string;
      uploads?: { path: string; type: "upload" }[];
    };
    expect(dispatchCall.text).toBe("take a look");
    expect(dispatchCall.uploads).toEqual([
      { path: "/uploads/note.txt", type: "upload" },
      { path: "/uploads/data.csv", type: "upload" },
    ]);
  });

  it("arms auto-merge via the pre-PR toggle path when armAutoMerge is true (docs/175)", async () => {
    const { poller, states, setEnabled } = fakeAutoMergePoller();

    const result = await createHeadlessSession(
      sessionManager,
      registry as unknown as SessionRunnerRegistry,
      claimService(),
      { repoUrl: "https://github.com/acme/app.git", prompt: "ship it", armAutoMerge: true },
      "claude",
      undefined,
      undefined,
      undefined,
      graduationDeps,
      { githubAuthManager: authedGitHub, prStatusPoller: poller },
    );

    // The same arm path the overflow toggle uses: no PR → setAutoMergeEnabled.
    expect(setEnabled).toHaveBeenCalledWith(result.sessionId, true);
    expect(states.get(result.sessionId)).toEqual({ enabled: true, mergeMethod: "squash" });

    // Decision #1 — never persisted to the session row / DB.
    const persisted = sessionManager.get(result.sessionId);
    expect(persisted).not.toHaveProperty("armAutoMerge");
    expect(persisted).not.toHaveProperty("autoMerge");
    expect(JSON.stringify(persisted)).not.toContain("autoMerge");
  });

  it("leaves auto-merge off when armAutoMerge is omitted", async () => {
    const { poller, states, setEnabled } = fakeAutoMergePoller();

    const result = await createHeadlessSession(
      sessionManager,
      registry as unknown as SessionRunnerRegistry,
      claimService(),
      { repoUrl: "https://github.com/acme/app.git", prompt: "no merge please" },
      "claude",
      undefined,
      undefined,
      undefined,
      graduationDeps,
      { githubAuthManager: authedGitHub, prStatusPoller: poller },
    );

    expect(setEnabled).not.toHaveBeenCalled();
    expect(states.get(result.sessionId)).toBeUndefined();
  });
});
