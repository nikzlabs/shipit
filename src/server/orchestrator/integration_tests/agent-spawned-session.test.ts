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
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
import { DatabaseManager } from "../../shared/database.js";
import {
  StubAuthManager,
  FakeClaudeProcess,
  TestClient,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

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
});
