import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// docs/156 — every session-creation surface now ends with `graduateSession`,
// which fires `generateSessionName` (real CLI child, 15s timeout) for any
// path without an explicit title+branch. Mock to null so the placeholder
// title sticks and the branch is unchanged. Without this, the
// no-explicit-title path would shell out to a real provider CLI.
vi.mock("../session-namer.js", () => ({
  generateSessionName: vi.fn().mockResolvedValue(null),
}));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { SessionManager } from "../sessions.js";
import { RepoStore } from "../repo-store.js";
import { GitManager } from "../../shared/git.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import type { GitHubAuthManager } from "../github-auth.js";
import { DatabaseManager } from "../../shared/database.js";
import {
  FakeClaudeProcess,
  StubAuthManager,
  StubGitHubAuthManager,
  createTestCredentialStore,
  createTestDatabaseManager,
  seedRepoCacheWithLocalBare,
} from "./test-helpers.js";

const REPO_URL = "https://github.com/owner/quick-capture-test.git";

async function waitFor(predicate: () => boolean, timeoutMs = 5000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor("${label}") timed out`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("Integration: quick-capture headless sessions", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  let repoStore: RepoStore;
  let createdAgents: FakeClaudeProcess[];
  let githubAuth: StubGitHubAuthManager;
  let origGitTerminalPrompt: string | undefined;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-quick-capture-"));
    origGitTerminalPrompt = process.env.GIT_TERMINAL_PROMPT;
    process.env.GIT_TERMINAL_PROMPT = "0";
    createdAgents = [];
    sessionManager = new SessionManager(dbManager);
    repoStore = new RepoStore(dbManager);

    // Set up credentials (which sets GIT_CONFIG_GLOBAL) before seeding the
    // cache — `seedRepoCacheWithLocalBare` writes its `insteadOf` redirect
    // there. Without this, warming would fire a real github.com fetch.
    const credentialStore = createTestCredentialStore(tmpDir);
    seedRepoCacheWithLocalBare({
      tmpDir,
      repoUrl: REPO_URL,
      seedFiles: { "README.md": "# quick-capture-test\n" },
    });
    repoStore.add(REPO_URL);
    repoStore.setReady(REPO_URL);

    githubAuth = new StubGitHubAuthManager();
    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      repoStore,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: githubAuth as unknown as GitHubAuthManager,
      agentFactory: () => {
        const agent = new FakeClaudeProcess();
        createdAgents.push(agent);
        return agent as never;
      },
      workspaceDir: tmpDir,
      serveStatic: false,
    });
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    if (origGitTerminalPrompt === undefined) {
      delete process.env.GIT_TERMINAL_PROMPT;
    } else {
      process.env.GIT_TERMINAL_PROMPT = origGitTerminalPrompt;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("POST /api/sessions/headless creates and starts a session without WebSocket attachment", { timeout: 15_000 }, async () => {
    // Wait for the warm pool to register a warm session before claiming.
    // buildApp() schedules warming via setTimeout(0); if claim runs before
    // that fires (CI load) it falls to the slow-clone path, which calls
    // `ensureBareCache` — the helper sees no `HEAD` file at the top of the
    // *non-bare* seeded cache and `rm -rf`s it, racing the warm pool's
    // concurrent `git fetch` for an ENOTEMPTY on `.git/`. Matches
    // `agent-spawned-session.test.ts`'s `claimGraduatedParent` waitFor.
    await waitFor(() => !!repoStore.get(REPO_URL)?.warmSessionId, 10_000, "warm session");

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/headless",
      payload: {
        repoUrl: REPO_URL,
        initialPrompt: "Fix the flaky test",
        branch: "quick/flaky-test",
        agent: "claude",
        model: "claude-sonnet-4-20250514",
      },
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      sessionId: string;
      branch: string;
      status: "running";
      session: { id: string; title: string };
    };
    expect(body).toMatchObject({
      branch: "quick/flaky-test",
      status: "running",
      session: { title: "Fix the flaky test" },
    });

    const session = sessionManager.get(body.sessionId);
    expect(session).toMatchObject({
      remoteUrl: REPO_URL,
      branch: "quick/flaky-test",
      branchRenamed: true,
      model: "claude-sonnet-4-20250514",
      agentId: "claude",
      agentPinned: true,
    });
    expect(session?.workspaceDir).toBeTruthy();
    await waitFor(() => createdAgents.some((agent) => agent.runCalled), 5000, "headless agent start");
    expect(createdAgents[0].lastPrompt).toBe("Fix the flaky test");
    expect(createdAgents[0].lastCwd).toBe(session?.workspaceDir);
    expect(execSync("git branch --show-current", {
      cwd: session!.workspaceDir!,
      encoding: "utf8",
    }).trim()).toBe("quick/flaky-test");
  });

  it("pins the model's agent when agent+model disagree (model is source of truth)", { timeout: 15_000 }, async () => {
    // docs/166: a caller (e.g. the quick-capture overlay with a stale
    // `vibe-agent-id`, or a legacy client) sends a Claude model with a
    // conflicting `agent: "codex"`. The model is authoritative, so the server
    // must derive and pin "claude", never the mismatched agent it was handed.
    await waitFor(() => !!repoStore.get(REPO_URL)?.warmSessionId, 10_000, "warm session");

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/headless",
      payload: {
        repoUrl: REPO_URL,
        initialPrompt: "Use the model's agent",
        branch: "quick/agent-derive",
        agent: "codex",
        model: "claude-opus-4-8",
      },
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { sessionId: string };
    const session = sessionManager.get(body.sessionId);
    expect(session).toMatchObject({
      model: "claude-opus-4-8",
      agentId: "claude",
      agentPinned: true,
    });
  });

  it("arms auto-merge at creation when armAutoMerge is true (docs/175)", { timeout: 15_000 }, async () => {
    // The pre-PR arm path requires GitHub auth (`toggleAutoMerge` throws 401
    // otherwise). Authenticate the stub, then create an armed quick session and
    // assert the poller seeded the per-session armed state — the same state the
    // overflow toggle would have set, which `activatePendingAutoMergeForPr`
    // applies once the first turn opens a PR.
    await githubAuth.setToken("test-token");
    await waitFor(() => !!repoStore.get(REPO_URL)?.warmSessionId, 10_000, "warm session");

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/headless",
      payload: {
        repoUrl: REPO_URL,
        initialPrompt: "Bump the dep and merge it",
        branch: "quick/arm-merge",
        agent: "claude",
        armAutoMerge: true,
      },
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { sessionId: string };

    const state = app.prStatusPoller?.getAutoMergeState(body.sessionId);
    expect(state?.enabled).toBe(true);

    // Decision #1 — the flag is transient: nothing about auto-merge is persisted
    // onto the session row / DB.
    expect(JSON.stringify(sessionManager.get(body.sessionId))).not.toContain("autoMerge");
  });

  it("does not arm auto-merge when the flag is omitted (docs/175)", { timeout: 15_000 }, async () => {
    await githubAuth.setToken("test-token");
    await waitFor(() => !!repoStore.get(REPO_URL)?.warmSessionId, 10_000, "warm session");

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/headless",
      payload: {
        repoUrl: REPO_URL,
        initialPrompt: "Just a normal session",
        branch: "quick/no-arm",
        agent: "claude",
      },
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { sessionId: string };
    expect(app.prStatusPoller?.getAutoMergeState(body.sessionId)).toBeUndefined();
  });

  it("rejects a non-boolean armAutoMerge (docs/175)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/headless",
      payload: {
        repoUrl: REPO_URL,
        initialPrompt: "bad flag",
        armAutoMerge: "yes" as unknown as boolean,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "armAutoMerge must be a boolean" });
  });

  it("maps validation errors through the HTTP route", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/headless",
      payload: {
        repoUrl: "",
        initialPrompt: "Second",
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Add a repo first." });
  });
});
