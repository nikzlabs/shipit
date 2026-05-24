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

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { RepoStore } from "../repo-store.js";
import { repoUrlToHash } from "../git-utils.js";
import { AuthManager } from "../auth.js";
import type { GitHubAuthManager } from "../github-auth.js";
import { DatabaseManager } from "../../shared/database.js";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  TestClient,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import {
  getSpawnTelemetrySnapshot,
  resetSpawnTelemetry,
} from "../services/spawn-telemetry.js";

describe("Integration: agent-spawned sessions (docs/117)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let dbManager: DatabaseManager;
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

    sessionManager = new SessionManager(dbManager);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
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
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // ignore cleanup errors
    }
  });

  /**
   * Stand up a parent session via the test-only /api/_test/sessions endpoint
   * and add a single commit so `git rev-parse HEAD` succeeds during the
   * spawn flow. Returns the parent's session id. This avoids the shared
   * `lastClaude` race in `waitForClaude` — we don't need an agent turn to
   * exercise the spawn route.
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
    const { execSync } = await import("node:child_process");
    execSync(
      "git add README.md && git -c user.email=test@test.com -c user.name=Test commit -m init",
      { cwd: workspaceDir },
    );
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
        branch: "port-api-ts",
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
    expect(body.branch).toBe("port-api-ts");
    expect(body.status).toBe("running");
    expect(body.session.title).toBe("Port API");
    expect(body.session.parentSessionId).toBe(parentId);
    expect(body.session.spawnedByTurn).toBe("turn-1");

    // Persisted in SQLite — reload through SessionManager and the linkage
    // should still be there.
    const reloaded = sessionManager.get(body.sessionId);
    expect(reloaded?.parentSessionId).toBe(parentId);
    expect(reloaded?.spawnedByTurn).toBe("turn-1");
    expect(reloaded?.branch).toBe("port-api-ts");
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

  it("POST /spawn rejects an invalid branch name with 400", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "x", branch: "has spaces" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Invalid branch name");
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
    // hit the limit. Each spawn uses a unique branch name to avoid
    // `git checkout -b` collisions.
    for (let i = 0; i < 4; i++) {
      const ok = await app.inject({
        method: "POST",
        url: `/api/sessions/${parentId}/spawn`,
        payload: { prompt: `child-${i}`, branch: `child-${i}`, spawnedByTurn: "turn-1" },
      });
      expect(ok.statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "child-5", branch: "child-5", spawnedByTurn: "turn-1" },
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
      payload: { prompt: "first", branch: "first" },
    });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "second", branch: "second" },
    });
    expect(r2.statusCode).toBe(200);

    const list = await app.inject({
      method: "GET",
      url: `/api/sessions/${parentId}/children`,
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { children: { id: string; branch: string }[] };
    expect(body.children).toHaveLength(2);
    // Should include both branches we just spawned.
    const branches = body.children.map((c) => c.branch);
    expect(branches).toContain("first");
    expect(branches).toContain("second");
  });

  it("GET /children/:childId returns the child + denies cross-tenancy access", { timeout: 15_000 }, async () => {
    const parentAId = await createParentSession("Parent A");
    const parentBId = await createParentSession("Parent B");

    // Spawn under parent A.
    const spawn = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentAId}/spawn`,
      payload: { prompt: "child", branch: "child-a" },
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
        payload: { prompt: "Port API to TS", title: "Port API", branch: "port-api-ts" },
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
      expect(spawnedMsg.branch).toBe("port-api-ts");
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
          payload: { prompt: `child-${i}`, branch: `child-${i}`, spawnedByTurn: "turn-1" },
        });
        expect(ok.statusCode).toBe(200);
      }

      // The 5th spawn under the same turn should 429 and emit a failure event.
      const limited = await app.inject({
        method: "POST",
        url: `/api/sessions/${parentId}/spawn`,
        payload: {
          prompt: "Spin up another worker for the migration",
          branch: "child-5",
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
        branch?: string;
        promptPreview?: string;
        failedAt: string;
      };

      expect(failedMsg.sessionId).toBe(parentId);
      expect(failedMsg.statusCode).toBe(429);
      expect(failedMsg.reason).toBe("quota_per_turn");
      expect(failedMsg.message).toContain("Per-turn spawn limit");
      expect(failedMsg.title).toBe("Worker 5");
      expect(failedMsg.branch).toBe("child-5");
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
        payload: { prompt: "x", branch: "has spaces" },
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
      payload: { prompt: "ok-1", branch: "ok-1", spawnedByTurn: "turn-1" },
    });
    expect(ok1.statusCode).toBe(200);

    // 400 invalid branch under the same turn.
    const bad = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "bad", branch: "has spaces", spawnedByTurn: "turn-1" },
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
  async function spawnChild(parentId: string, opts: { branch?: string; prompt?: string } = {}): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: {
        prompt: opts.prompt ?? "child task",
        branch: opts.branch ?? `child-${Math.random().toString(36).slice(2, 8)}`,
      },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { sessionId: string }).sessionId;
  }

  /**
   * Spawn a child and drive its FakeClaudeProcess to `finish()` so the
   * runner reports idle. Returns the child id.
   *
   * `spawnChildSession` enqueues the initial prompt via `sendSystemMessage`,
   * which (with SystemTurnDeps wired by `createRunnerRegistry`) starts a
   * system turn against a freshly-created FakeClaudeProcess. Tests need to
   * finish that turn explicitly — the fake doesn't auto-emit `done`.
   */
  async function spawnAndIdleChild(parentId: string, opts: { branch?: string } = {}): Promise<string> {
    const before = createdClaudes.length;
    const childId = await spawnChild(parentId, opts);
    // The spawn fires `sendSystemMessage` synchronously, which calls
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
    const childId = await spawnChild(parentAId, { branch: "child-a" });

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
    const childId = await spawnChild(parentAId, { branch: "child-a" });

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${parentBId}/children/${childId}?wait=true&timeout=1`,
    });
    expect(res.statusCode).toBe(404);
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
    const childId = await spawnChild(parentAId, { branch: "child-a" });

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
    await spawnChild(parentId, { branch: "params-parity" });

    // Wait for the spawn's `sendSystemMessage` → buildRunParams → agent.run.
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
      payload: { prompt: "x", branch: "child-model-test" },
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
});

// -------------------------------------------------------------------------
// Remote-path spawn: when the parent's repo is registered, the spawn flow
// routes through the same claim service as the home-screen "send with repo"
// flow. The child's workspace is branched off freshly-fetched `origin/main`,
// not off the parent's HEAD — so the "Changes vs main" diff is empty even
// when the parent has accumulated committed work on its own branch.
// -------------------------------------------------------------------------

const SPAWN_REPO_URL = "https://github.com/owner/spawn-remote-test.git";

function getSpawnRepoCacheDir(workspaceDir: string, repoUrl: string): string {
  return path.join(workspaceDir, "repo-cache", repoUrlToHash(repoUrl));
}

/**
 * Create a fake bare cache with a single commit on `main` and an
 * `origin/main` ref pointing at HEAD. The fake `origin` URL won't resolve,
 * but `fetchAndResolveDefaultBranch` falls back to local refs on fetch
 * failure — so the claim path still cuts the branch off this commit.
 */
function createCachedRepo(repoDir: string): void {
  fs.mkdirSync(repoDir, { recursive: true });
  execSync("git init", { cwd: repoDir, stdio: "ignore" });
  execSync("git checkout -b main", { cwd: repoDir, stdio: "ignore" });
  fs.writeFileSync(path.join(repoDir, "README.md"), "# spawn-remote-test\n");
  execSync("git add .", { cwd: repoDir, stdio: "ignore" });
  execSync('git -c user.email=t@t.com -c user.name=Test commit -m init --no-gpg-sign', { cwd: repoDir, stdio: "ignore" });
  execSync(`git remote add origin ${SPAWN_REPO_URL}`, { cwd: repoDir, stdio: "ignore" });
  execSync("git update-ref refs/remotes/origin/main HEAD", { cwd: repoDir, stdio: "ignore" });
}

async function waitFor(predicate: () => boolean, timeoutMs = 10000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor("${label}") timed out`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("Integration: spawn from registered remote (claim path, docs/117 + this fix)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let repoStore: RepoStore;
  let dbManager: DatabaseManager;
  let origGitTerminalPrompt: string | undefined;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-spawn-remote-"));

    origGitTerminalPrompt = process.env.GIT_TERMINAL_PROMPT;
    process.env.GIT_TERMINAL_PROMPT = "0";

    sessionManager = new SessionManager(dbManager);
    repoStore = new RepoStore(dbManager);

    // Pre-create the bare cache so the warm pool and the claim path both
    // find a usable repo at startup.
    createCachedRepo(getSpawnRepoCacheDir(tmpDir, SPAWN_REPO_URL));

    repoStore.add(SPAWN_REPO_URL);
    repoStore.setReady(SPAWN_REPO_URL);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      repoStore,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as never,
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    await app.listen({ port: 0, host: "127.0.0.1" });
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
   * Stand up a parent session via claim, then simulate it having received
   * its first message — i.e. `warm = false`. Without this graduation step
   * the claim path's `findUngraduatedWarm` would lookup the parent itself
   * as a reusable warm session and the spawn would alias to the parent's
   * own workspace. In production the parent has always been used (the
   * spawn arrives during an agent turn that started from a user message),
   * so warm is already false by the time spawn fires.
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
      payload: { prompt: "do the thing", branch: "spawn-test-child" },
    });
    expect(spawnRes.statusCode).toBe(200);
    const { sessionId: childId } = spawnRes.json() as { sessionId: string };

    const child = sessionManager.get(childId);
    expect(child?.workspaceDir).toBeDefined();
    expect(child?.workspaceDir).not.toBe(parentWorkspace);

    // The fix: child's HEAD is at origin/main, NOT inherited from parent's HEAD.
    const childHead = execSync("git rev-parse HEAD", {
      cwd: child!.workspaceDir!,
      encoding: "utf8",
    }).trim();
    expect(childHead).toBe(mainSha);
    expect(childHead).not.toBe(parentHead);

    // Child is on the requested branch.
    const childBranch = execSync("git branch --show-current", {
      cwd: child!.workspaceDir!,
      encoding: "utf8",
    }).trim();
    expect(childBranch).toBe("spawn-test-child");

    // Child must be a fully-graduated session, not a warm-pool slot.
    expect(child?.warm).toBeFalsy();
    expect(child?.branchRenamed).toBe(true);
    expect(child?.parentSessionId).toBe(parentId);
    expect(child?.remoteUrl).toBe(SPAWN_REPO_URL);
  });

  it("honors opts.base by resetting HEAD after the claim", { timeout: 30_000 }, async () => {
    // Add an extra commit to the cache so we have a non-HEAD commit reachable
    // from origin/main's history. `opts.base` must resolve in the child's
    // clone (a copy of the cache), so the commit has to live there — pushing
    // from the parent's workspace into a non-bare cache fails on
    // receive.denyCurrentBranch, hence we commit directly in the cache.
    const cacheDir = getSpawnRepoCacheDir(tmpDir, SPAWN_REPO_URL);
    const baseSha = execSync("git rev-parse HEAD", { cwd: cacheDir, encoding: "utf8" }).trim();
    fs.writeFileSync(path.join(cacheDir, "tip.txt"), "tip\n");
    execSync(
      'git add tip.txt && git -c user.email=t@t.com -c user.name=Test commit -m tip --no-gpg-sign',
      { cwd: cacheDir },
    );
    execSync("git update-ref refs/remotes/origin/main HEAD", { cwd: cacheDir });
    const tipSha = execSync("git rev-parse HEAD", { cwd: cacheDir, encoding: "utf8" }).trim();
    expect(tipSha).not.toBe(baseSha);

    const { parentId } = await claimGraduatedParent();
    await waitFor(() => !!repoStore.get(SPAWN_REPO_URL)?.warmSessionId, 10000, "re-warm");

    const spawnRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "x", branch: "base-test", base: baseSha },
    });
    expect(spawnRes.statusCode).toBe(200);
    const { sessionId: childId } = spawnRes.json() as { sessionId: string };
    const child = sessionManager.get(childId)!;

    const childHead = execSync("git rev-parse HEAD", { cwd: child.workspaceDir!, encoding: "utf8" }).trim();
    expect(childHead).toBe(baseSha);
    expect(childHead).not.toBe(tipSha);
  });
});
