import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { CredentialStore } from "../credential-store.js";
import { ProviderAccountManager } from "../provider-account-manager.js";
import { GitManager } from "../../shared/git.js";
import { createHeadlessSession, type HeadlessSessionGraduationDeps } from "./headless-sessions.js";
import { ServiceError } from "./types.js";
import type { ClaimSessionService } from "./claim-session.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { AgentId } from "../../shared/types.js";

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

describe("createHeadlessSession", () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  let registry: FakeRunnerRegistry;
  let nextSession = 0;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-headless-svc-"));
    dbManager = new DatabaseManager(":memory:");
    sessionManager = new SessionManager(dbManager);
    registry = new FakeRunnerRegistry();
    nextSession = 0;
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

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
    )).rejects.toMatchObject({ statusCode: 400, message: "Add a repo first." });

    await expect(createHeadlessSession(
      sessionManager,
      registry as unknown as SessionRunnerRegistry,
      claim,
      { repoUrl: "https://github.com/acme/app.git", prompt: "   " },
      "claude",
      undefined,
      undefined,
    )).rejects.toMatchObject({ statusCode: 400, message: "prompt is required" });

    expect(claim.claim).not.toHaveBeenCalled();
  });

  it("enforces the active quick-session cap", async () => {
    await createHeadlessSession(
      sessionManager,
      registry as unknown as SessionRunnerRegistry,
      claimService(),
      {
        repoUrl: "https://github.com/acme/app.git",
        prompt: "first",
        maxActiveHeadlessSessions: 1,
      },
      "claude",
      undefined,
      undefined,
    );

    await expect(createHeadlessSession(
      sessionManager,
      registry as unknown as SessionRunnerRegistry,
      claimService(),
      {
        repoUrl: "https://github.com/acme/app.git",
        prompt: "second",
        maxActiveHeadlessSessions: 1,
      },
      "claude",
      undefined,
      undefined,
    )).rejects.toMatchObject({
      statusCode: 429,
      message: "You already have 1 quick sessions running. Open one from the sidebar before starting another.",
    });
  });

  it("routes credential provisioning through providerAccountManager when one is supplied", async () => {
    // Regression for the quick-session "not logged in" bug. After
    // `migrateDefaultAccounts()` runs at orchestrator startup, the legacy
    // `<credentialsDir>/.claude` (and `.codex`) becomes a symlink into
    // `provider-accounts/`. The headless path used to skip
    // `providerAccountManager`, so `prepareSessionAgentEnvironment` fell into
    // the legacy `provisionAgentCredentials` branch, which copied the symlink
    // verbatim into the per-session subtree — pointing at an orchestrator path
    // the container can't resolve. The fix forwards the manager so
    // `selectRouteForTurn` picks the account route and provisions from the
    // real account directory. Asserting `providerRoute*` metadata on the
    // session is the cleanest way to prove the route selector was consulted
    // without standing up a real container runner. The two agents share the
    // exact same plumbing, so we exercise both to make sure the symmetry
    // doesn't drift.
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".claude.json"), "{}");
    fs.mkdirSync(path.join(tmpDir, ".codex"), { recursive: true });
    const credentialStore = new CredentialStore(tmpDir);
    const providerAccountManager = new ProviderAccountManager({
      credentialsDir: tmpDir,
      credentialStore,
    });
    providerAccountManager.migrateDefaultAccounts();
    expect(providerAccountManager.getPrimary("claude")?.id).toBe("claude-default");
    expect(providerAccountManager.getPrimary("codex")?.id).toBe("codex-default");

    await createHeadlessSession(
      sessionManager,
      registry as unknown as SessionRunnerRegistry,
      claimService(),
      { repoUrl: "https://github.com/acme/app.git", prompt: "do it", agent: "claude" },
      "claude",
      tmpDir,
      credentialStore,
      providerAccountManager,
    );
    const claudeSession = sessionManager.get("quick-1");
    expect(claudeSession?.providerRouteKind).toBe("account");
    expect(claudeSession?.providerRouteId).toBe("claude-default");

    await createHeadlessSession(
      sessionManager,
      registry as unknown as SessionRunnerRegistry,
      claimService(),
      { repoUrl: "https://github.com/acme/app.git", prompt: "do it", agent: "codex" },
      "claude",
      tmpDir,
      credentialStore,
      providerAccountManager,
    );
    const codexSession = sessionManager.get("quick-2");
    expect(codexSession?.providerRouteKind).toBe("account");
    expect(codexSession?.providerRouteId).toBe("codex-default");
  });

  it("defers branchRenamed when graduation deps are wired and no branch/title is pinned", async () => {
    // Structural assertion for the warm-graduation parity fix: when the caller
    // doesn't pin a branch/title and the route wired graduation deps,
    // `createHeadlessSession` hands ownership of `branchRenamed` to the shared
    // `scheduleSessionNaming` flow (the same one warm graduation uses). The
    // synchronous return therefore leaves `branchRenamed` unset; the async
    // chain — driven by the real CLI — flips it once the rename completes.
    // We deliberately do not await that chain here: the cross-flow naming
    // logic is unit-tested in `session-graduation.test.ts` with a mocked CLI.
    const graduationDeps: HeadlessSessionGraduationDeps = {
      createGitManager: (dir: string) => new GitManager(dir),
      prStatusPoller: { getStatus: vi.fn(() => undefined) } as unknown as PrStatusPoller,
      sseBroadcast: vi.fn(),
    };

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
    expect(result.session.branch).toMatch(/^shipit\/[a-z0-9]{1,6}$/);
    expect(result.session.branchRenamed).toBeUndefined();
  });

  it("marks branchRenamed immediately when graduation deps are not wired (test/local mode)", async () => {
    // Mirror image of the previous test: when the route doesn't pass
    // `graduationDeps` (e.g. a runtime without a PR poller), the synchronous
    // `setBranchRenamed(true)` keeps the PR card flow unblocked.
    const result = await createHeadlessSession(
      sessionManager,
      registry as unknown as SessionRunnerRegistry,
      claimService(),
      { repoUrl: "https://github.com/acme/app.git", prompt: "do it" },
      "claude",
      undefined,
      undefined,
    );
    expect(result.session.branchRenamed).toBe(true);
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
    )).rejects.toMatchObject({ statusCode: 500, message: "clone failed" });
  });
});
