import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { SessionManager } from "../sessions.js";
import { RepoStore } from "../repo-store.js";
import { GitManager } from "../../shared/git.js";
import { AuthManager } from "../auth.js";
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

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      repoStore,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
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
