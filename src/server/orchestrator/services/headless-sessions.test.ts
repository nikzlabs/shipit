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
import { createHeadlessSession, seedFromIssueRef, isIssueSeededBranch } from "./headless-sessions.js";
import type { GraduateSessionDeps } from "./graduate-session.js";
import { ServiceError } from "./types.js";
import type { ClaimSessionService } from "./claim-session.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { AgentId, AutoMergeState } from "../../shared/types.js";
import type * as InstalledHarnesses from "../../shared/installed-harnesses.js";

type InstalledHarnessesModule = typeof InstalledHarnesses;

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


describe("seedFromIssueRef — branch names carry the pointer only", () => {
  it("omits a Linear issue title from the branch", () => {
    const seed = seedFromIssueRef({
      tracker: "linear",
      identifier: "SHI-304",
      title: "Acquire competitor before Q3 board meeting",
    });
    expect(seed.branch).toMatch(/^shi-304-[a-z0-9_-]{1,6}$/);
    expect(seed.branch).not.toMatch(/acquire|competitor|board/);
  });

  it("omits a GitHub issue title from the branch, keeping the qualified pointer", () => {
    const seed = seedFromIssueRef({
      tracker: "github:acme/planning",
      identifier: "acme/planning#42",
      title: "Secret roadmap item",
    });
    expect(seed.branch).toMatch(/^acme-planning-42-[a-z0-9_-]{1,6}$/);
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

  it("gives two sessions on the same issue different branches", () => {
    const ref = { tracker: "linear" as const, identifier: "SHI-1", title: "A" };
    const first = seedFromIssueRef(ref).branch;
    const second = seedFromIssueRef(ref).branch;
    expect(first).not.toBe(second);
    expect(first).toMatch(/^shi-1-/);
    expect(second).toMatch(/^shi-1-/);
  });

  it("keeps a long pointer's branch inside a sane length", () => {
    const seed = seedFromIssueRef({
      tracker: "github:acme/planning",
      identifier: `acme/${"very-long-repo-name".repeat(5)}#4321`,
      title: "T",
    });
    expect(seed.branch.length).toBeLessThanOrEqual(60);
  });

  it("recognizes a branch seeded from a given pointer, and only that pointer", () => {
    const branch = seedFromIssueRef({ tracker: "linear", identifier: "SHI-1", title: "A" }).branch;
    expect(isIssueSeededBranch(branch, "SHI-1")).toBe(true);
    expect(isIssueSeededBranch("shipit/ab12cd", "SHI-1")).toBe(false);
    expect(isIssueSeededBranch("shipit/ab12cd", "###")).toBe(false);
  });

  it("does not confuse pointers whose stems prefix each other", () => {
    const one = seedFromIssueRef({ tracker: "linear", identifier: "SHI-1", title: "A" }).branch;
    const twelve = seedFromIssueRef({ tracker: "linear", identifier: "SHI-12", title: "A" }).branch;
    expect(isIssueSeededBranch(twelve, "SHI-1")).toBe(false);
    expect(isIssueSeededBranch(one, "SHI-12")).toBe(false);
    expect(isIssueSeededBranch(twelve, "SHI-12")).toBe(true);
  });

  it("still recognizes a legacy unsuffixed branch", () => {
    expect(isIssueSeededBranch("shi-304", "SHI-304")).toBe(true);
    expect(isIssueSeededBranch("shi-304", "SHI-30")).toBe(false);
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
  // Permit account migration into the test's temporary credential root when running inside ShipIt.
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
        title: "Fix the failing tests",
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
    expect(result.branch).toMatch(/^shipit\/[a-z0-9_-]{1,6}$/);
    expect(result.session).toMatchObject({
      id: "quick-1",
      title: "Fix the failing tests",
      branch: result.branch,
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
    }).trim()).toBe(result.branch);
  });

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
          agent: "codex",
          model: "deepseek-flash",
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

    it("refuses an agent id no harness has, rather than silently using the model's", async () => {
      const service = claimService();

      await expect(createHeadlessSession(
        sessionManager,
        registry as unknown as SessionRunnerRegistry,
        service,
        {
          repoUrl: "https://github.com/acme/app.git",
          prompt: "unknown harness",
          agent: "codexx" as AgentId,
          model: "claude-opus-5",
        },
        "claude",
        undefined,
        undefined,
        undefined,
        graduationDeps,
      )).rejects.toMatchObject({
        statusCode: 400,
        message: "Unknown agent 'codexx'. Valid agents: claude, codex, opencode, grok.",
      });

      expect(service.claim).not.toHaveBeenCalled();
      expect(sessionManager.list()).toEqual([]);
    });

    it("refuses an unknown agent id with no model too — one rule, not two", async () => {
      await expect(createHeadlessSession(
        sessionManager,
        registry as unknown as SessionRunnerRegistry,
        claimService(),
        {
          repoUrl: "https://github.com/acme/app.git",
          prompt: "unknown harness, no model",
          agent: "gemini" as AgentId,
        },
        "claude",
        undefined,
        undefined,
        undefined,
        graduationDeps,
      )).rejects.toMatchObject({ statusCode: 400, message: /^Unknown agent 'gemini'\./ });
    });
  });

  it("persists a valid reasoning effort on the session row before the first turn", async () => {
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

  it("drops a harness level that the resolved model does not offer", async () => {
    await createHeadlessSession(
      sessionManager,
      registry as unknown as SessionRunnerRegistry,
      claimService(),
      {
        repoUrl: "https://github.com/acme/app.git",
        prompt: "reason hard",
        model: "gpt-6-astra",
        serviceId: "openai",
        billingMode: "key",
        reasoning: "minimal",
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

  it("accepts an empty prompt when the message carries attachments (docs/293 req 5)", async () => {
    const claim = claimService();
    const created = await createHeadlessSession(
      sessionManager,
      registry as unknown as SessionRunnerRegistry,
      claim,
      {
        repoUrl: "https://github.com/acme/app.git",
        prompt: "   ",
        uploads: [{ filename: "pasted-text.txt", data: Buffer.from("a pasted blob") }],
      },
      "claude",
      undefined,
      undefined,
      undefined,
      graduationDeps,
    );
    expect(created).toBeTruthy();
    expect(claim.claim).toHaveBeenCalled();
    const arg = registry.get(created.sessionId)?.dispatch.mock.calls[0][0] as {
      text: string;
      uploads?: unknown[];
    };
    expect(arg.text).toBe("");
    expect(arg.uploads).toHaveLength(1);
  });

  it("keeps env-prep account-neutral: no selection, no provisioning (docs/260 §5b)", async () => {
    // Migration requires credential content; empty directories do not establish an account.
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
    expect(markUsed).not.toHaveBeenCalled();
    const claudeSession = sessionManager.get("quick-1");
    expect(claudeSession?.providerRouteKind).toBeUndefined();
    expect(claudeSession?.providerRouteId).toBeUndefined();
    expect((registry.get("quick-1") as { residentRoute?: unknown } | undefined)?.residentRoute)
      .toBeUndefined();
    expect(readSessionAccountMarker(tmpDir, "quick-1")).toEqual({});
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
    expect(markUsed).not.toHaveBeenCalled();
    const codexSession = sessionManager.get("quick-2");
    expect(codexSession?.providerRouteKind).toBeUndefined();
    expect(codexSession?.providerRouteId).toBeUndefined();
    expect(readSessionAccountMarker(tmpDir, "quick-2")).toEqual({});
    expect(registry.get("quick-2")?.dispatch).toHaveBeenCalledTimes(1);
  });

  it("defers branchRenamed when no explicit branch/title is pinned", async () => {
    // Do not await the real naming CLI; graduate-session.test.ts covers completion with a mock.
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

    expect(result.branch).toMatch(/^shi-67-[a-z0-9_-]{1,6}$/);
    expect(result.branch).not.toContain("inline");
    expect(result.session.title).toBe("SHI-67: Inline tracker Issues tab");
    expect(result.session.branch).toBe(result.branch);
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

    expect(setEnabled).toHaveBeenCalledWith(result.sessionId, true);
    expect(states.get(result.sessionId)).toEqual({ enabled: true, mergeMethod: "squash" });

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
