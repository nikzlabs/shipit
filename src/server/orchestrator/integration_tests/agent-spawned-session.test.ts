/**
 * Integration tests for agent-spawned sessions (docs/117).
 *
 * The shim → worker → orchestrator hops are covered by their own unit tests
 * (`shipit.test.ts`, `agent-ops-routes.test.ts`). This file exercises the
 * orchestrator end of the chain:
 *
 *   POST /api/sessions/:parentId/spawn
 *   GET  /api/sessions/:parentId/children
 *   GET  /api/sessions/:parentId/children/:childId
 *
 * Plus the SQL-backed parent-linkage persistence, the per-parent quota
 * enforcement, and the cross-tenancy denial on `view`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// docs/156 — every session-creation surface now ends with `graduateSession`,
// which fires `generateSessionName` (a real CLI child) for any path that
// doesn't pin both an explicit title and branch. Mock it to null so naming
// is a no-op for these tests; the placeholder title from the prompt slice
// stays, and the on-disk branch is untouched. Without this, every
// prompt-without-title spawn here would fork a real `claude`/`codex`
// process (15s timeout each) and race against the AI rename — the per-turn
// quota test alone would spawn four real processes.
vi.mock("../session-namer.js", () => ({
  generateSessionName: vi.fn().mockResolvedValue(null),
}));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { RepoStore } from "../repo-store.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import type { GitHubAuthManager } from "../github-auth.js";
import { DatabaseManager } from "../../shared/database.js";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  TestClient,
  createTestCredentialStore,
  createTestDatabaseManager,
  seedRepoCacheWithLocalBare,
} from "./test-helpers.js";
import {
  getSpawnTelemetrySnapshot,
  resetSpawnTelemetry,
} from "../services/spawn-telemetry.js";

// Single registered remote shared by every describe in this file. Both the
// "default" suite (parents created via the test endpoint with `remoteUrl`
// wired) and the "claim path" suite (parents created via the real claim
// endpoint) use this URL — `spawnChildSession` always routes through
// `ClaimSessionService`, so every parent needs a ready registered repo.
//
// All actual `git fetch` traffic is redirected to a per-test local bare repo
// via `seedRepoCacheWithLocalBare` (see test-helpers.ts) so warming + claim
// stay on local I/O.
const SPAWN_REPO_URL = "https://github.com/owner/spawn-remote-test.git";

async function waitFor(predicate: () => boolean, timeoutMs = 10000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor("${label}") timed out`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("Integration: agent-spawned sessions (docs/117)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let repoStore: RepoStore;
  let dbManager: DatabaseManager;
  let origGitTerminalPrompt: string | undefined;
  /** Capture every FakeClaudeProcess the orchestrator creates so Phase 3
   *  tests can drive them to `finish()` and assert idle/archive behavior. */
  let createdClaudes: FakeClaudeProcess[];

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-spawn-"));
    createdClaudes = [];
    // Module-level singleton: zero between tests so counter assertions are
    // independent of test order.
    resetSpawnTelemetry();
    // Keep claim's workspace fetches from blocking on credential prompts.
    origGitTerminalPrompt = process.env.GIT_TERMINAL_PROMPT;
    process.env.GIT_TERMINAL_PROMPT = "0";

    sessionManager = new SessionManager(dbManager);
    repoStore = new RepoStore(dbManager);

    // Materialize per-test GIT_CONFIG_GLOBAL first — `seedRepoCacheWithLocalBare`
    // writes the `insteadOf` redirect into it, and we need that done before
    // any `git fetch SPAWN_REPO_URL` fires (i.e. before buildApp's startup
    // warming runs).
    const credentialStore = createTestCredentialStore(tmpDir);

    // Spawn always routes through the home-screen claim service — the parent
    // must be backed by a "ready" registered repo. The helper seeds the bare
    // cache + mirrors it as a local bare + wires `insteadOf` so every
    // subsequent warm-pool / claim fetch resolves locally.
    seedRepoCacheWithLocalBare({
      tmpDir,
      repoUrl: SPAWN_REPO_URL,
      seedFiles: { "README.md": "# spawn-remote-test\n" },
    });
    repoStore.add(SPAWN_REPO_URL);
    repoStore.setReady(SPAWN_REPO_URL);

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      repoStore,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => {
        const cp = new FakeClaudeProcess();
        createdClaudes.push(cp);
        return cp as never;
      },
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = /:(\d+)$/.exec(address);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    if (origGitTerminalPrompt === undefined) {
      delete process.env.GIT_TERMINAL_PROMPT;
    } else {
      process.env.GIT_TERMINAL_PROMPT = origGitTerminalPrompt;
    }
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // ignore cleanup errors
    }
  });

  /**
   * Stand up a parent session via the test-only /api/_test/sessions endpoint,
   * stamp `remoteUrl` so it satisfies spawn's "must have a registered repo"
   * precondition, and add a single commit so the workspace looks like a
   * regular session. Returns the parent's session id. This avoids the
   * shared `lastClaude` race in `waitForClaude` — we don't need an agent
   * turn to exercise the spawn route.
   */
  async function createParentSession(title = "Parent"): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/_test/sessions",
      payload: { title },
    });
    expect(res.statusCode).toBe(200);
    const { sessionId, workspaceDir } = res.json() as {
      sessionId: string;
      sessionDir: string;
      workspaceDir: string;
    };

    fs.writeFileSync(path.join(workspaceDir, "README.md"), "# Parent\n");
    execSync(
      "git add README.md && git -c user.email=test@test.com -c user.name=Test commit -m init",
      { cwd: workspaceDir },
    );

    // Spawn's claim path resolves the child's workspace via `parent.remoteUrl`
    // — wire it up here so every parent created in this suite can spawn.
    sessionManager.setRemoteUrl(sessionId, SPAWN_REPO_URL);
    return sessionId;
  }

  // -------------------------------------------------------------------------
  // Spawn happy path
  // -------------------------------------------------------------------------

  it("POST /spawn creates a child session with parent linkage persisted", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: {
        prompt: "Port API to TS",
        title: "Port API",
        spawnedByTurn: "turn-1",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      sessionId: string;
      branch: string;
      status: string;
      session: { id: string; title: string; parentSessionId?: string; spawnedByTurn?: string };
    };
    // The agent cannot pick the branch name; it's always auto-generated
    // under the `shipit/` namespace.
    expect(body.branch).toMatch(/^shipit\//);
    expect(body.status).toBe("running");
    expect(body.session.title).toBe("Port API");
    expect(body.session.parentSessionId).toBe(parentId);
    expect(body.session.spawnedByTurn).toBe("turn-1");

    // Persisted in SQLite — reload through SessionManager and the linkage
    // should still be there.
    const reloaded = sessionManager.get(body.sessionId);
    expect(reloaded?.parentSessionId).toBe(parentId);
    expect(reloaded?.spawnedByTurn).toBe("turn-1");
    expect(reloaded?.branch).toBe(body.branch);
  });

  it("POST /spawn rejects an empty prompt with 400", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "  " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("prompt is required");
  });

  it("POST /spawn rejects an over-long prompt with 400", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "x".repeat(50_001) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("50,000");
  });

  it("POST /spawn requires a title and rejects a spawn without one (400)", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "Port API to TS" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/title is required/i);

    // No child was created.
    const children = await app.inject({ method: "GET", url: `/api/sessions/${parentId}/children` });
    expect((children.json().children as unknown[]).length).toBe(0);
  });

  it("POST /spawn returns 404 for a nonexistent parent", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/nonexistent/spawn",
      payload: { prompt: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Quotas
  // -------------------------------------------------------------------------

  it("POST /spawn enforces the per-turn quota and surfaces 429", { timeout: 30_000 }, async () => {
    const parentId = await createParentSession();

    // Default per-turn cap is 4. Spawning a 5th with the same turn id should
    // hit the limit. Branch names are auto-generated per spawn so there's no
    // collision concern.
    for (let i = 0; i < 4; i++) {
      const ok = await app.inject({
        method: "POST",
        url: `/api/sessions/${parentId}/spawn`,
        payload: { prompt: `child-${i}`, title: `Child ${i}`, spawnedByTurn: "turn-1" },
      });
      expect(ok.statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "child-5", spawnedByTurn: "turn-1" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toContain("Per-turn spawn limit");
  });

  // -------------------------------------------------------------------------
  // Reads (list + view) + cross-tenancy denial
  // -------------------------------------------------------------------------

  it("GET /children lists spawned children with most-recent first", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();

    const r1 = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "first", title: "First child" },
    });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "second", title: "Second child" },
    });
    expect(r2.statusCode).toBe(200);

    const list = await app.inject({
      method: "GET",
      url: `/api/sessions/${parentId}/children`,
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { children: { id: string; branch: string }[] };
    expect(body.children).toHaveLength(2);
    // Branch names are auto-generated; just assert both got distinct shipit/ branches.
    const branches = body.children.map((c) => c.branch);
    expect(branches.every((b) => b.startsWith("shipit/"))).toBe(true);
    expect(new Set(branches).size).toBe(2);
  });

  it("GET /children/:childId returns the child + denies cross-tenancy access", { timeout: 15_000 }, async () => {
    const parentAId = await createParentSession("Parent A");
    const parentBId = await createParentSession("Parent B");

    // Spawn under parent A.
    const spawn = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentAId}/spawn`,
      payload: { prompt: "child", title: "Child under A" },
    });
    const childId = (spawn.json() as { sessionId: string }).sessionId;

    // View under parent A — OK.
    const okView = await app.inject({
      method: "GET",
      url: `/api/sessions/${parentAId}/children/${childId}`,
    });
    expect(okView.statusCode).toBe(200);
    expect((okView.json() as { child: { id: string } }).child.id).toBe(childId);

    // View the same child via parent B — must 404 (cross-tenancy denial).
    // The orchestrator deliberately doesn't tell the requester "wrong parent",
    // it just says "not found" — protecting the existence of the child from
    // an agent that didn't spawn it.
    const blockedView = await app.inject({
      method: "GET",
      url: `/api/sessions/${parentBId}/children/${childId}`,
    });
    expect(blockedView.statusCode).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Phase 2: session_spawned WS broadcast on the parent runner
  // -------------------------------------------------------------------------

  it("broadcasts a `session_spawned` event on the parent's runner after a successful spawn", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();

    // Attach a WS to the parent session — this is what creates a runner in
    // the registry. Without an attached viewer the spawn route would still
    // succeed but the `session_spawned` emit would have nowhere to go.
    const parentClient = await TestClient.connect(port, parentId);

    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${parentId}/spawn`,
        payload: { prompt: "Port API to TS", title: "Port API" },
      });
      expect(res.statusCode).toBe(200);
      const { sessionId: childId } = res.json() as { sessionId: string };

      // Wait for the spawn event. Earlier messages may include `preview_status`
      // / session-list flutter from the WS attach — `receiveType` skips
      // anything that isn't the type we want.
      const spawnedMsg = await parentClient.receiveType("session_spawned", 5000) as {
        type: "session_spawned";
        sessionId: string;
        childSessionId: string;
        title: string;
        branch?: string;
        spawnedAt: string;
      };

      expect(spawnedMsg.sessionId).toBe(parentId);
      expect(spawnedMsg.childSessionId).toBe(childId);
      expect(spawnedMsg.title).toBe("Port API");
      expect(spawnedMsg.branch).toMatch(/^shipit\//);
      expect(typeof spawnedMsg.spawnedAt).toBe("string");
    } finally {
      parentClient.close();
    }
  });

  // -------------------------------------------------------------------------
  // Cross-cutting follow-up: spawn failures surface inline + telemetry counted
  // -------------------------------------------------------------------------

  it("broadcasts a `session_spawn_failed` event on the parent's runner when the per-turn quota fires", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();
    const parentClient = await TestClient.connect(port, parentId);

    try {
      // Saturate the per-turn cap (default 4).
      for (let i = 0; i < 4; i++) {
        const ok = await app.inject({
          method: "POST",
          url: `/api/sessions/${parentId}/spawn`,
          payload: { prompt: `child-${i}`, title: `Child ${i}`, spawnedByTurn: "turn-1" },
        });
        expect(ok.statusCode).toBe(200);
      }

      // The 5th spawn under the same turn should 429 and emit a failure event.
      const limited = await app.inject({
        method: "POST",
        url: `/api/sessions/${parentId}/spawn`,
        payload: {
          prompt: "Spin up another worker for the migration",
          title: "Worker 5",
          spawnedByTurn: "turn-1",
        },
      });
      expect(limited.statusCode).toBe(429);

      const failedMsg = await parentClient.receiveType("session_spawn_failed", 5000) as {
        type: "session_spawn_failed";
        sessionId: string;
        message: string;
        statusCode: number;
        reason: string;
        title?: string;
        promptPreview?: string;
        failedAt: string;
      };

      expect(failedMsg.sessionId).toBe(parentId);
      expect(failedMsg.statusCode).toBe(429);
      expect(failedMsg.reason).toBe("quota_per_turn");
      expect(failedMsg.message).toContain("Per-turn spawn limit");
      expect(failedMsg.title).toBe("Worker 5");
      expect(failedMsg.promptPreview).toContain("Spin up another worker");
      expect(typeof failedMsg.failedAt).toBe("string");
    } finally {
      parentClient.close();
    }
  });

  it("broadcasts a `session_spawn_failed` event when the request is malformed (400 invalid_request)", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();
    const parentClient = await TestClient.connect(port, parentId);
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${parentId}/spawn`,
        payload: { prompt: "x".repeat(50_001) },
      });
      expect(res.statusCode).toBe(400);

      const failedMsg = await parentClient.receiveType("session_spawn_failed", 5000) as {
        type: "session_spawn_failed";
        reason: string;
        statusCode: number;
      };
      expect(failedMsg.reason).toBe("invalid_request");
      expect(failedMsg.statusCode).toBe(400);
    } finally {
      parentClient.close();
    }
  });

  it("records a telemetry invocation for each spawn attempt, dimensioned by outcome and agent", { timeout: 30_000 }, async () => {
    const parentId = await createParentSession();
    resetSpawnTelemetry(); // ignore parent-setup noise

    // Successful spawn under turn-1.
    const ok1 = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "ok-1", title: "OK one", spawnedByTurn: "turn-1" },
    });
    expect(ok1.statusCode).toBe(200);

    // 400 invalid request (over-long prompt) under the same turn.
    const bad = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "x".repeat(50_001), spawnedByTurn: "turn-1" },
    });
    expect(bad.statusCode).toBe(400);

    // 404 nonexistent parent — counted against the route, not the parent.
    const notFound = await app.inject({
      method: "POST",
      url: "/api/sessions/nonexistent/spawn",
      payload: { prompt: "boom" },
    });
    expect(notFound.statusCode).toBe(404);

    const snap = getSpawnTelemetrySnapshot();
    expect(snap.total).toBe(3);
    expect(snap.byOutcome.success).toBe(1);
    expect(snap.byOutcome.invalid_request).toBe(1);
    expect(snap.byOutcome.parent_missing).toBe(1);
    expect(snap.byParent[parentId]).toBe(2);
    expect(snap.byTurn["turn-1"]).toBe(2);
    // Default agent in this test app is claude (see test-helpers).
    expect(snap.byAgent.claude).toBeGreaterThanOrEqual(3);
  });

  // -------------------------------------------------------------------------
  // Phase 3: message / wait / archive
  // -------------------------------------------------------------------------

  /** Spawn one child under the given parent, returning the child id. */
  async function spawnChild(parentId: string, opts: { prompt?: string } = {}): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: {
        prompt: opts.prompt ?? "child task",
        title: "Child task",
      },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { sessionId: string }).sessionId;
  }

  /**
   * Spawn a child and drive its FakeClaudeProcess to `finish()` so the
   * runner reports idle. Returns the child id.
   *
   * `spawnChildSession` enqueues the initial prompt via `runner.dispatch`,
   * which (with SystemTurnDeps wired by `createRunnerRegistry`) starts a
   * system turn against a freshly-created FakeClaudeProcess. Tests need to
   * finish that turn explicitly — the fake doesn't auto-emit `done`.
   */
  async function spawnAndIdleChild(parentId: string): Promise<string> {
    const before = createdClaudes.length;
    const childId = await spawnChild(parentId);
    // The spawn fires `runner.dispatch` synchronously, which calls
    // `agentFactory(...)` — so the new FakeClaudeProcess lands in
    // `createdClaudes` before the spawn route returns. Poll defensively to
    // tolerate any async deferral.
    const deadline = Date.now() + 2000;
    while (createdClaudes.length === before && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const cp = createdClaudes[createdClaudes.length - 1];
    cp.finish();
    // `agent.on("done")` runs an async auto-commit before resetting
    // `running = false`. Wait until the runner reports idle.
    await new Promise((r) => setTimeout(r, 50));
    return childId;
  }

  it("POST /children/:childId/message enqueues a prompt on the child runner", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();
    // Don't idle the child — we want to see queueing-behind-a-running-turn.
    const childId = await spawnChild(parentId);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/children/${childId}/message`,
      payload: { text: "Also do X" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { queuePosition: number; enqueued: boolean };
    expect(body.enqueued).toBe(true);
    expect(body.queuePosition).toBeGreaterThanOrEqual(1);
  });

  it("POST /children/:childId/message starts a turn directly when the child is idle", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();
    const childId = await spawnAndIdleChild(parentId);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/children/${childId}/message`,
      payload: { text: "Also do X" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { queuePosition: number; enqueued: boolean };
    expect(body.enqueued).toBe(false);
    expect(body.queuePosition).toBe(0);
  });

  it("POST /children/:childId/message rejects an empty body with 400", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();
    const childId = await spawnChild(parentId);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/children/${childId}/message`,
      payload: { text: "   " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("required");
  });

  it("POST /children/:childId/message returns 404 for a cross-tenant child", { timeout: 15_000 }, async () => {
    const parentAId = await createParentSession("Parent A");
    const parentBId = await createParentSession("Parent B");
    const childId = await spawnChild(parentAId);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentBId}/children/${childId}/message`,
      payload: { text: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /children/:childId?wait=true returns immediately when the child is already idle", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();
    const childId = await spawnAndIdleChild(parentId);

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${parentId}/children/${childId}?wait=true&timeout=5`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { idle: boolean; timedOut: boolean; child: { id: string } };
    expect(body.idle).toBe(true);
    expect(body.timedOut).toBe(false);
    expect(body.child.id).toBe(childId);
  });

  it("GET /children/:childId?wait=true blocks until the child finishes the running turn", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();
    const before = createdClaudes.length;
    const childId = await spawnChild(parentId);

    // Wait for the child's FakeClaudeProcess to be created.
    const claudeDeadline = Date.now() + 2000;
    while (createdClaudes.length === before && Date.now() < claudeDeadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const cp = createdClaudes[createdClaudes.length - 1];

    // Kick off the long-poll BEFORE finishing the agent so we exercise the
    // "register an idle listener" code path.
    const waitPromise = app.inject({
      method: "GET",
      url: `/api/sessions/${parentId}/children/${childId}?wait=true&timeout=10`,
    });
    // Yield a tick so the route attaches its idle listener.
    await new Promise((r) => setTimeout(r, 30));
    cp.finish();

    const res = await waitPromise;
    expect(res.statusCode).toBe(200);
    const body = res.json() as { idle: boolean; timedOut: boolean };
    expect(body.idle).toBe(true);
    expect(body.timedOut).toBe(false);
  });

  it("GET /children/:childId?wait=true times out when the child stays running", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();
    const childId = await spawnChild(parentId);

    // Don't finish the FakeClaudeProcess; let the wait hit its 1-second cap.
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${parentId}/children/${childId}?wait=true&timeout=1`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { idle: boolean; timedOut: boolean };
    expect(body.idle).toBe(false);
    expect(body.timedOut).toBe(true);
  });

  it("GET /children/:childId?wait=true returns 404 for a cross-tenant child", { timeout: 15_000 }, async () => {
    const parentAId = await createParentSession("Parent A");
    const parentBId = await createParentSession("Parent B");
    const childId = await spawnChild(parentAId);

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${parentBId}/children/${childId}?wait=true&timeout=1`,
    });
    expect(res.statusCode).toBe(404);
  });

  /**
   * docs/182 — drive the child's FakeClaudeProcess to an errored turn (a
   * `result` with subtype `error`, then `done`) so the readiness check records
   * the distinct `error` outcome.
   */
  async function spawnAndErrorChild(parentId: string): Promise<string> {
    const before = createdClaudes.length;
    const childId = await spawnChild(parentId);
    const deadline = Date.now() + 2000;
    while (createdClaudes.length === before && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const cp = createdClaudes[createdClaudes.length - 1];
    cp.emit("event", { type: "result", subtype: "error", session_id: "test-session", result: "boom" });
    cp.emit("done", 1);
    await new Promise((r) => setTimeout(r, 50));
    return childId;
  }

  it("GET /children/:childId?wait=true reports outcome=error after the child's turn errors", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();
    const childId = await spawnAndErrorChild(parentId);

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${parentId}/children/${childId}?wait=true&timeout=5`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { idle: boolean; outcome: string; child: { status: string } };
    expect(body.outcome).toBe("error");
    expect(body.idle).toBe(false);
    expect(body.child.status).toBe("error");
  });

  it("GET /children/:childId?wait=true&segment=1 returns outcome=pending while the child runs", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();
    // Leave the child running — a bounded 1s segment should return `pending`.
    const childId = await spawnChild(parentId);

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${parentId}/children/${childId}?wait=true&timeout=10&segment=1`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { idle: boolean; pending: boolean; outcome: string };
    expect(body.outcome).toBe("pending");
    expect(body.pending).toBe(true);
    expect(body.idle).toBe(false);
  });

  it("POST /children/:childId/archive archives an idle child the parent spawned", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();
    const childId = await spawnAndIdleChild(parentId);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/children/${childId}/archive`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { archived: boolean; sessions: { id: string }[] };
    expect(body.archived).toBe(true);

    // Reload through SessionManager — the child should now be archived.
    const reloaded = sessionManager.get(childId);
    expect(reloaded?.archived).toBe(true);
  });

  it("POST /children/:childId/archive refuses to archive a running child with 409", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();
    const childId = await spawnChild(parentId);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/children/${childId}/archive`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("running");
  });

  it("POST /children/:childId/archive returns 404 for a cross-tenant child", { timeout: 15_000 }, async () => {
    const parentAId = await createParentSession("Parent A");
    const parentBId = await createParentSession("Parent B");
    const childId = await spawnChild(parentAId);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentBId}/children/${childId}/archive`,
    });
    expect(res.statusCode).toBe(404);
  });

  // -------------------------------------------------------------------------
  // docs/149 — run-params parity: the spawned session's first agent.run(...)
  // call must include the same fields the user-WS path provides (system prompt
  // with agent instructions, managed-settings.json, model, MCP, autoCreatePr).
  // Without this, agent-spawned sessions used to run blind — no settings means
  // no branch-block hook, no PR-enforcement; no system prompt means the agent
  // doesn't know about /shipit-docs/ etc.
  // -------------------------------------------------------------------------

  it("spawned session's first agent.run(...) carries the full WS-path params", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();
    const before = createdClaudes.length;
    await spawnChild(parentId);

    // Wait for the spawn's `runner.dispatch` → buildRunParams → agent.run.
    const deadline = Date.now() + 2000;
    while (createdClaudes.length === before && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const cp = createdClaudes[createdClaudes.length - 1];
    expect(cp).toBeDefined();
    // buildRunParams is async; let the microtask flush before asserting.
    const runDeadline = Date.now() + 2000;
    while (!cp.runCalled && Date.now() < runDeadline) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(cp.runCalled).toBe(true);
    // System prompt carries the agent instructions block (sentinel from
    // buildAgentSystemInstructions). Without these, the spawned agent doesn't
    // know about /shipit-docs/, the PR workflow, etc.
    expect(cp.lastSystemPrompt).toBeTruthy();
    expect(cp.lastSystemPrompt).toContain("ShipIt");
    // Managed-settings drives the PreToolUse branch-block + Stop-hook PR
    // enforcement. Claude-only.
    expect(cp.lastSettingsPath).toBe("/etc/shipit/managed-settings.json");
    // autoCreatePr defaults to false in test mode (no GitHub auth) — what
    // matters is that the field is populated, not magic-undefined.
    expect(cp.lastAutoCreatePr).toBe(false);
    // MCP servers list is empty in tests (no configured servers), so the
    // field should be undefined per our omit-when-empty contract.
    expect(cp.lastMcpServers).toBeUndefined();
  });

  it("spawned session inherits the parent's model selection", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();
    sessionManager.setModel(parentId, "claude-opus-4-7");

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "x", title: "Inherit model" },
    });
    expect(res.statusCode).toBe(200);

    const deadline = Date.now() + 3000;
    while (createdClaudes.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const cp = createdClaudes[createdClaudes.length - 1];
    const runDeadline = Date.now() + 3000;
    while (!cp.runCalled && Date.now() < runDeadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(cp.lastModel).toBe("claude-opus-4-7");
  });

  it("prepareSessionAgentEnvironment is idempotent: provisioning runs once, pin sticks", { timeout: 15_000 }, async () => {
    // Direct unit-style assertion against the env-prep function — verifies
    // the agentPinned flag gates the provisioning block so subsequent calls
    // are no-ops.
    const { prepareSessionAgentEnvironment } = await import("../session-agent-env.js");
    const { SessionRunner } = await import("../session-runner.js");

    const parentId = await createParentSession();
    const session = sessionManager.get(parentId);
    expect(session?.agentPinned).toBeFalsy();

    const runner = new SessionRunner({
      sessionId: parentId,
      sessionDir: session!.workspaceDir!,
      defaultAgentId: "claude",
    });
    const deps = {
      credentialsDir: tmpDir,
      credentialStore: createTestCredentialStore(tmpDir),
      sessionManager,
    };

    await prepareSessionAgentEnvironment(runner, {
      sessionId: parentId,
      agentId: "claude",
      deps,
    });
    expect(sessionManager.get(parentId)?.agentPinned).toBe(true);
    expect(sessionManager.get(parentId)?.agentId).toBe("claude");

    // Second call — must not re-pin and must not throw.
    await prepareSessionAgentEnvironment(runner, {
      sessionId: parentId,
      agentId: "claude",
      deps,
    });
    expect(sessionManager.get(parentId)?.agentPinned).toBe(true);

    runner.dispose();
  });

  // -------------------------------------------------------------------------
  // Claim-path freshness: spawn always routes through `claimSessionService`,
  // so the child's workspace is branched off freshly-fetched `origin/main`,
  // not off the parent's HEAD. The "Changes vs main" diff is empty even when
  // the parent has accumulated committed work on its own branch.
  // -------------------------------------------------------------------------

  /**
   * Stand up a parent through the *real* claim endpoint (mirroring the
   * home-screen flow) and graduate it. Used by tests that need to drive the
   * parent's workspace before spawning — `createParentSession` above wires
   * `remoteUrl` directly and skips claim, which is enough for routing tests
   * but doesn't give the parent a claim-shaped workspace.
   *
   * The `setWarm(false)` step matters: without it `findUngraduatedWarm`
   * would resurface the parent itself as a reusable warm session and the
   * spawn's claim would alias to the parent's own workspace.
   */
  async function claimGraduatedParent(): Promise<{ parentId: string; workspaceDir: string }> {
    await waitFor(() => !!repoStore.get(SPAWN_REPO_URL)?.warmSessionId, 10000, "warm session");
    const claimRes = await app.inject({
      method: "POST",
      url: `/api/repos/${encodeURIComponent(SPAWN_REPO_URL)}/claim-session`,
    });
    expect(claimRes.statusCode).toBe(200);
    const { sessionId: parentId } = claimRes.json() as { sessionId: string };
    sessionManager.setWarm(parentId, false);
    const parent = sessionManager.get(parentId)!;
    return { parentId, workspaceDir: parent.workspaceDir! };
  }

  it("spawns the child branched off origin/main, NOT off parent's HEAD", { timeout: 30_000 }, async () => {
    const { parentId, workspaceDir: parentWorkspace } = await claimGraduatedParent();

    // Capture origin/main BEFORE the parent diverges from it.
    const mainSha = execSync("git rev-parse origin/main", {
      cwd: parentWorkspace,
      encoding: "utf8",
    }).trim();

    // Simulate parent doing committed-but-unmerged work — the scenario that
    // used to leak into spawned children's "Changes vs main".
    fs.writeFileSync(path.join(parentWorkspace, "wip.txt"), "parent WIP\n");
    execSync(
      'git add wip.txt && git -c user.email=t@t.com -c user.name=Test commit -m "parent wip" --no-gpg-sign',
      { cwd: parentWorkspace },
    );
    const parentHead = execSync("git rev-parse HEAD", {
      cwd: parentWorkspace,
      encoding: "utf8",
    }).trim();
    expect(parentHead).not.toBe(mainSha);

    // Wait for the pool to re-warm so the spawn's claim has a session to
    // grab quickly (either path is correct; this just makes timing predictable).
    await waitFor(() => !!repoStore.get(SPAWN_REPO_URL)?.warmSessionId, 10000, "re-warm after parent claim");

    const spawnRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "do the thing", title: "Do the thing" },
    });
    expect(spawnRes.statusCode).toBe(200);
    const { sessionId: childId } = spawnRes.json() as { sessionId: string };

    const child = sessionManager.get(childId);
    expect(child?.workspaceDir).toBeDefined();
    expect(child?.workspaceDir).not.toBe(parentWorkspace);

    const childHead = execSync("git rev-parse HEAD", {
      cwd: child!.workspaceDir!,
      encoding: "utf8",
    }).trim();
    expect(childHead).toBe(mainSha);
    expect(childHead).not.toBe(parentHead);

    const childBranch = execSync("git branch --show-current", {
      cwd: child!.workspaceDir!,
      encoding: "utf8",
    }).trim();
    expect(childBranch).toMatch(/^shipit\//);

    // Child must be a fully-graduated session, not a warm-pool slot.
    expect(child?.warm).toBeFalsy();
    expect(child?.branchRenamed).toBe(true);
    expect(child?.parentSessionId).toBe(parentId);
    expect(child?.remoteUrl).toBe(SPAWN_REPO_URL);
  });

  it("POST /spawn rejects a parent with no registered remote URL", { timeout: 15_000 }, async () => {
    // Bypass `createParentSession`'s `setRemoteUrl` wiring so the parent has
    // no `remoteUrl` at all — spawn must refuse rather than silently fall
    // back to a local clone (the deleted fallback path).
    const res = await app.inject({
      method: "POST",
      url: "/api/_test/sessions",
      payload: { title: "Parent" },
    });
    const { sessionId: parentId } = res.json() as { sessionId: string };

    const spawnRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "no remote please" },
    });
    expect(spawnRes.statusCode).toBe(400);
    expect(spawnRes.json().error).toMatch(/no remote URL/i);
  });
});

