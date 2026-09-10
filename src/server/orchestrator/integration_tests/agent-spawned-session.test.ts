import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Prevent naming from launching a real agent CLI.
vi.mock("../session-namer.js", () => ({
  generateSessionName: vi.fn().mockResolvedValue({ name: null }),
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
import type { CredentialStore } from "../credential-store.js";
import { DEFAULT_MAX_SPAWNED_SESSIONS_PER_TURN } from "../services/child-sessions.js";
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
  let createdClaudes: FakeClaudeProcess[];
  let credentialStore: CredentialStore;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-spawn-"));
    createdClaudes = [];
    resetSpawnTelemetry();
    origGitTerminalPrompt = process.env.GIT_TERMINAL_PROMPT;
    process.env.GIT_TERMINAL_PROMPT = "0";

    sessionManager = new SessionManager(dbManager);
    repoStore = new RepoStore(dbManager);

    // Create the isolated Git config before seeding its fetch redirect.
    credentialStore = createTestCredentialStore(tmpDir);

    // Redirect fetches locally before buildApp starts warming sessions.
    seedRepoCacheWithLocalBare({
      tmpDir,
      repoUrl: SPAWN_REPO_URL,
      seedFiles: { "README.md": "# spawn-remote-test\n" },
    });
    repoStore.add(SPAWN_REPO_URL);
    repoStore.setReady(SPAWN_REPO_URL);
    repoStore.setTrusted(SPAWN_REPO_URL, true);

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

    sessionManager.setRemoteUrl(sessionId, SPAWN_REPO_URL);
    return sessionId;
  }

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
      session: { id: string; title: string; parentSessionId?: string; spawnedByTurn?: string; rootSessionId?: string };
    };
    expect(body.branch).toMatch(/^shipit\//);
    expect(body.status).toBe("running");
    expect(body.session.title).toBe("Port API");
    expect(body.session.parentSessionId).toBe(parentId);
    expect(body.session.spawnedByTurn).toBe("turn-1");
    expect(body.session.rootSessionId).toBe(parentId);

    const reloaded = sessionManager.get(body.sessionId);
    expect(reloaded?.parentSessionId).toBe(parentId);
    expect(reloaded?.spawnedByTurn).toBe("turn-1");
    expect(reloaded?.rootSessionId).toBe(parentId);
    expect(reloaded?.branch).toBe(body.branch);
  });

  it("docs/252 — a child inherits the parent's SELECTION, retirement resolved", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession("Retired parent");
    sessionManager.setAgentId(parentId, "codex");
    sessionManager.setModelSelection(parentId, {
      serviceId: "openai",
      billingMode: "key",
      modelId: "gpt-5.6",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "Do the thing", title: "Child of a retired parent" },
    });
    expect(res.statusCode).toBe(200);
    const { sessionId: childId } = res.json() as { sessionId: string };

    const child = sessionManager.get(childId);
    expect(child?.model).toBe("gpt-5.6-sol");
    expect(child?.serviceId).toBe("openai");
    expect(child?.billingMode).toBe("key");

    expect(sessionManager.get(parentId)?.model).toBe("gpt-5.6-sol");
    expect(sessionManager.get(parentId)?.billingMode).toBe("key");
  });

  it("docs/201 — a grandchild inherits the root ancestor, not its immediate parent", { timeout: 20_000 }, async () => {
    const rootId = await createParentSession();

    const childRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${rootId}/spawn`,
      payload: { prompt: "Intermediate child work", title: "Child" },
    });
    expect(childRes.statusCode).toBe(200);
    const childId = (childRes.json() as { sessionId: string }).sessionId;
    expect(sessionManager.get(childId)?.rootSessionId).toBe(rootId);

    const grandRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${childId}/spawn`,
      payload: { prompt: "Grandchild work", title: "Grandchild" },
    });
    expect(grandRes.statusCode).toBe(200);
    const grand = (grandRes.json() as {
      sessionId: string;
      session: { parentSessionId?: string; rootSessionId?: string };
    });
    expect(grand.session.parentSessionId).toBe(childId);
    expect(grand.session.rootSessionId).toBe(rootId);

    const reloaded = sessionManager.get(grand.sessionId);
    expect(reloaded?.parentSessionId).toBe(childId);
    expect(reloaded?.rootSessionId).toBe(rootId);
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

  it("POST /spawn enforces the per-turn quota and surfaces 429", { timeout: 30_000 }, async () => {
    const parentId = await createParentSession();

    for (let i = 0; i < DEFAULT_MAX_SPAWNED_SESSIONS_PER_TURN; i++) {
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
      payload: { prompt: "child-over-cap", spawnedByTurn: "turn-1" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toContain("Per-turn spawn limit");
  });

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
    const branches = body.children.map((c) => c.branch);
    expect(branches.every((b) => b.startsWith("shipit/"))).toBe(true);
    expect(new Set(branches).size).toBe(2);
  });

  it("GET /children/:childId returns the child + denies cross-tenancy access", { timeout: 15_000 }, async () => {
    const parentAId = await createParentSession("Parent A");
    const parentBId = await createParentSession("Parent B");

    const spawn = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentAId}/spawn`,
      payload: { prompt: "child", title: "Child under A" },
    });
    const childId = (spawn.json() as { sessionId: string }).sessionId;

    const okView = await app.inject({
      method: "GET",
      url: `/api/sessions/${parentAId}/children/${childId}`,
    });
    expect(okView.statusCode).toBe(200);
    expect((okView.json() as { child: { id: string } }).child.id).toBe(childId);

    const blockedView = await app.inject({
      method: "GET",
      url: `/api/sessions/${parentBId}/children/${childId}`,
    });
    expect(blockedView.statusCode).toBe(404);
  });

  it("broadcasts a `session_spawned` event on the parent's runner after a successful spawn", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();

    const parentClient = await TestClient.connect(port, parentId);

    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${parentId}/spawn`,
        payload: { prompt: "Port API to TS", title: "Port API" },
      });
      expect(res.statusCode).toBe(200);
      const { sessionId: childId } = res.json() as { sessionId: string };

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

  it("broadcasts a `session_spawn_failed` event on the parent's runner when the per-turn quota fires", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();
    const parentClient = await TestClient.connect(port, parentId);

    try {
      for (let i = 0; i < DEFAULT_MAX_SPAWNED_SESSIONS_PER_TURN; i++) {
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
        payload: {
          prompt: "Spin up another worker for the migration",
          title: "Worker over cap",
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
      expect(failedMsg.title).toBe("Worker over cap");
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
    resetSpawnTelemetry();

    const ok1 = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "ok-1", title: "OK one", spawnedByTurn: "turn-1" },
    });
    expect(ok1.statusCode).toBe(200);

    const bad = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "x".repeat(50_001), spawnedByTurn: "turn-1" },
    });
    expect(bad.statusCode).toBe(400);

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
    expect(snap.byAgent.claude).toBeGreaterThanOrEqual(3);
  });

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

  async function spawnAndIdleChild(parentId: string): Promise<string> {
    const before = createdClaudes.length;
    const childId = await spawnChild(parentId);
    const deadline = Date.now() + 2000;
    while (createdClaudes.length === before && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const cp = createdClaudes[createdClaudes.length - 1];
    cp.finish();
    await new Promise((r) => setTimeout(r, 50));
    return childId;
  }

  it("POST /children/:childId/message enqueues a prompt on the child runner", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();
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
    const runner = (app as unknown as { runnerRegistry: { get(id: string): { messageQueue: { messageOrigin?: unknown }[] } } }).runnerRegistry.get(childId);
    expect(runner.messageQueue.at(-1)?.messageOrigin).toEqual({
      sessionId: parentId,
      sessionTitle: "Parent",
      relation: "parent",
    });
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

    const claudeDeadline = Date.now() + 2000;
    while (createdClaudes.length === before && Date.now() < claudeDeadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const cp = createdClaudes[createdClaudes.length - 1];

    const waitPromise = app.inject({
      method: "GET",
      url: `/api/sessions/${parentId}/children/${childId}?wait=true&timeout=10`,
    });
    // Allow the route to attach its idle listener before finishing the turn.
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

  it("spawned session's first agent.run(...) carries the full WS-path params", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();
    const before = createdClaudes.length;
    await spawnChild(parentId);

    const deadline = Date.now() + 2000;
    while (createdClaudes.length === before && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const cp = createdClaudes[createdClaudes.length - 1];
    expect(cp).toBeDefined();
    // The factory runs before async parameter preparation finishes.
    const runDeadline = Date.now() + 2000;
    while (!cp.runCalled && Date.now() < runDeadline) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(cp.runCalled).toBe(true);
    expect(cp.lastSystemPrompt).toBeTruthy();
    expect(cp.lastSystemPrompt).toContain("ShipIt");
    expect(cp.lastSettingsPath).toBe("/etc/shipit/managed-settings.json");
    expect(cp.lastAutoCreatePr).toBe(false);
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

  it("docs/217 — spawned session inherits the parent's reasoning level", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();
    sessionManager.setModel(parentId, "claude-opus-4-7");
    sessionManager.setReasoning(parentId, "high");

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "x", title: "Inherit reasoning" },
    });
    expect(res.statusCode).toBe(200);
    const childId = (res.json() as { sessionId: string }).sessionId;
    expect(sessionManager.get(childId)?.reasoningEffort).toBe("high");

    const deadline = Date.now() + 3000;
    while (createdClaudes.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const cp = createdClaudes[createdClaudes.length - 1];
    const runDeadline = Date.now() + 3000;
    while (!cp.runCalled && Date.now() < runDeadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(cp.lastReasoningEffort).toBe("high");
  });

  it("docs/217 — a level the child's harness doesn't offer is dropped, not forwarded", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();
    sessionManager.setAgentId(parentId, "codex");
    sessionManager.setModel(parentId, "gpt-5.5");
    sessionManager.setReasoning(parentId, "minimal");

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "x", title: "Cross-harness reasoning", agent: "claude" },
    });
    expect(res.statusCode).toBe(200);
    const childId = (res.json() as { sessionId: string }).sessionId;
    expect(sessionManager.get(childId)?.agentId).toBe("claude");
    expect(sessionManager.get(childId)?.reasoningEffort).toBeUndefined();

    sessionManager.setReasoning(parentId, "high");
    const ok = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "x", title: "Cross-harness reasoning ok", agent: "claude" },
    });
    expect(ok.statusCode).toBe(200);
    const okChildId = (ok.json() as { sessionId: string }).sessionId;
    expect(sessionManager.get(okChildId)?.reasoningEffort).toBe("high");
  });

  it("a bare --agent switch does not carry the parent's model onto the new backend", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();
    sessionManager.setModel(parentId, "claude-opus-4-7");

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "x", title: "Switch backend", agent: "codex" },
    });
    expect(res.statusCode).toBe(200);
    // Use the response snapshot: turn preparation can already have filled the live row's empty model.
    const childId = (res.json() as { sessionId: string }).sessionId;
    const child = (res.json() as { session: { model?: string; serviceId?: string } }).session;
    expect(sessionManager.get(childId)?.agentId).toBe("codex");
    expect(child.model).toBeUndefined();
    expect(child.serviceId).toBeUndefined();

    const same = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "x", title: "Same backend", agent: "claude" },
    });
    expect(same.statusCode).toBe(200);
    expect((same.json() as { session: { model?: string } }).session.model).toBe("claude-opus-4-7");
  });

  function seedPinnedRole(name: string, prompt?: string): void {
    credentialStore.upsertCredentialRouteWithSecret(
      {
        id: "anthropic-key",
        serviceId: "anthropic",
        billingMode: "key",
        via: "string",
        status: "ready",
        priority: 0,
        isPrimary: true,
        label: "test",
        createdAt: 0,
        updatedAt: 0,
      },
      "sk-test",
    );
    credentialStore.setRole(name, {
      name,
      description: "Slow, thorough review",
      ...(prompt ? { prompt } : {}),
      params: {
        kind: "pinned",
        harnessId: "claude",
        serviceId: "anthropic",
        billingMode: "key",
        modelId: "claude-opus-5",
        reasoningEffort: "high",
      },
    });
  }

  it("a role seeds the child's COMPLETE tuple, not just an agent and a model", { timeout: 15_000 }, async () => {
    seedPinnedRole("deep dive");
    const parentId = await createParentSession();
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "x", title: "Role spawn", role: "deep dive" },
    });
    expect(res.statusCode).toBe(200);
    const childId = (res.json() as { sessionId: string }).sessionId;
    const child = sessionManager.get(childId);
    expect(child?.agentId).toBe("claude");
    expect(child?.model).toBe("claude-opus-5");
    expect(child?.serviceId).toBe("anthropic");
    expect(child?.billingMode).toBe("key");
    expect(child?.reasoningEffort).toBe("high");
    expect(child?.originRoleName).toBe("deep dive");
  });

  it("keeps originRoleName as a snapshot when the role is edited or deleted", { timeout: 15_000 }, async () => {
    seedPinnedRole("deep dive");
    const parentId = await createParentSession();
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "x", title: "Role spawn", role: "deep dive" },
    });
    const childId = (res.json() as { sessionId: string }).sessionId;
    credentialStore.setRole("deep dive", null);
    expect(sessionManager.get(childId)?.originRoleName).toBe("deep dive");
    expect(sessionManager.get(childId)?.model).toBe("claude-opus-5");
  });

  it("joins a role's standing instructions onto the child's first prompt (req 8)", { timeout: 15_000 }, async () => {
    seedPinnedRole("deep dive", "Check the code against requirements.md.");
    const parentId = await createParentSession();
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "Review PR 12", title: "Role spawn", role: "deep dive" },
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
    expect(cp.lastPrompt).toContain("Check the code against requirements.md.");
    expect(cp.lastPrompt).toContain("Review PR 12");
    expect(cp.lastPrompt).toContain("Standing instructions");
  });

  describe("inheriting the parent's role (req 20)", () => {
    async function roleRunningParent(prompt?: string): Promise<string> {
      seedPinnedRole("deep dive", prompt ?? "Read the whole subsystem first.");
      const parentId = await createParentSession();
      sessionManager.setAgentId(parentId, "claude");
      sessionManager.setModelSelection(parentId, {
        serviceId: "anthropic",
        billingMode: "key",
        modelId: "claude-opus-5",
      });
      sessionManager.setReasoning(parentId, "high");
      sessionManager.setRoleName(parentId, "deep dive");
      return parentId;
    }

    async function firstPromptOf(): Promise<string> {
      const deadline = Date.now() + 3000;
      while (createdClaudes.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      const cp = createdClaudes[createdClaudes.length - 1];
      const runDeadline = Date.now() + 3000;
      while (!cp.runCalled && Date.now() < runDeadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      return cp.lastPrompt ?? "";
    }

    it("carries the name, the record and the standing instructions", { timeout: 15_000 }, async () => {
      const parentId = await roleRunningParent();
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${parentId}/spawn`,
        payload: { prompt: "Port the API", title: "Inherited role" },
      });
      expect(res.statusCode).toBe(200);
      const child = sessionManager.get((res.json() as { sessionId: string }).sessionId);
      expect(child?.originRoleName).toBe("deep dive");
      expect(child?.roleName).toBe("deep dive");
      const prompt = await firstPromptOf();
      expect(prompt).toContain("Read the whole subsystem first.");
      expect(prompt).toContain("Port the API");
    });

    it("keeps the role when the spawn overrides a parameter", { timeout: 15_000 }, async () => {
      const parentId = await roleRunningParent();
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${parentId}/spawn`,
        payload: { prompt: "x", title: "Overridden", modelId: "claude-sonnet-5" },
      });
      expect(res.statusCode).toBe(200);
      const child = sessionManager.get((res.json() as { sessionId: string }).sessionId);
      expect(child?.model).toBe("claude-sonnet-5");
      expect(child?.roleName).toBe("deep dive");
      expect(await firstPromptOf()).toContain("Read the whole subsystem first.");
    });

    it("declines it on --no-role, keeping the parameters", { timeout: 15_000 }, async () => {
      const parentId = await roleRunningParent();
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${parentId}/spawn`,
        payload: { prompt: "Fix the unrelated logging bug", title: "No role", noRole: true },
      });
      expect(res.statusCode).toBe(200);
      const child = sessionManager.get((res.json() as { sessionId: string }).sessionId);
      expect(child?.roleName).toBeUndefined();
      expect(child?.originRoleName).toBeUndefined();
      expect(child?.agentId).toBe("claude");
      expect(child?.model).toBe("claude-opus-5");
      const prompt = await firstPromptOf();
      expect(prompt).not.toContain("Read the whole subsystem first.");
      expect(prompt).toContain("Fix the unrelated logging bug");
    });

    it("refuses --no-role alongside --role rather than picking one", { timeout: 15_000 }, async () => {
      const parentId = await roleRunningParent();
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${parentId}/spawn`,
        payload: { prompt: "x", title: "Both", role: "deep dive", noRole: true },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/opposite things/);
    });

    it("inherits nothing role-shaped when the role has since been deleted", { timeout: 15_000 }, async () => {
      const parentId = await roleRunningParent();
      credentialStore.setRole("deep dive", null);
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${parentId}/spawn`,
        payload: { prompt: "x", title: "Ghost role" },
      });
      expect(res.statusCode).toBe(200);
      const child = sessionManager.get((res.json() as { sessionId: string }).sessionId);
      expect(child?.roleName).toBeUndefined();
      expect(child?.originRoleName).toBeUndefined();
      expect(child?.model).toBe("claude-opus-5");
    });

    it("leaves a complete explicit target role-less", { timeout: 15_000 }, async () => {
      const parentId = await roleRunningParent();
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${parentId}/spawn`,
        payload: {
          prompt: "x",
          title: "Explicit",
          agentId: "claude",
          serviceId: "anthropic",
          billingMode: "key",
          modelId: "claude-sonnet-5",
          reasoningEffort: "high",
        },
      });
      expect(res.statusCode).toBe(200);
      const child = sessionManager.get((res.json() as { sessionId: string }).sessionId);
      expect(child?.roleName).toBeUndefined();
      expect(child?.originRoleName).toBeUndefined();
    });
  });

  it("still refuses an empty prompt when the role carries standing instructions", { timeout: 15_000 }, async () => {
    seedPinnedRole("deep dive", "Check the code against requirements.md.");
    const parentId = await createParentSession();
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "   ", title: "Empty", role: "deep dive" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/prompt is required/);
  });

  it("refuses an unknown role and names the roles that do exist (req 13)", { timeout: 15_000 }, async () => {
    seedPinnedRole("deep dive");
    const parentId = await createParentSession();
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "x", title: "Bad role", role: "critic" },
    });
    expect(res.statusCode).toBe(400);
    const err = (res.json() as { error: string }).error;
    expect(err).toContain("critic");
    expect(err).toContain("deep dive");
    expect(err).toContain("reviewer");
  });

  for (const [field, flag] of [
    ["agentId", "--agent"],
    ["modelId", "--model"],
    ["serviceId", "--service"],
    ["reasoningEffort", "--effort"],
    ["agent", "--agent"],
    ["model", "--model"],
  ] as const) {
    it(`refuses a child spawn whose ${field} is present but empty`, { timeout: 15_000 }, async () => {
      seedPinnedRole("deep dive");
      const parentId = await createParentSession();
      const before = sessionManager.list().length;
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${parentId}/spawn`,
        payload: { prompt: "x", title: "Empty override", role: "deep dive", [field]: "" },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toContain(flag);
      expect(sessionManager.list().length).toBe(before);
    });
  }

  it("starts a role whose name has spaces round it, exactly as stored", { timeout: 15_000 }, async () => {
    seedPinnedRole(" deep dive ");
    const parentId = await createParentSession();
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "x", title: "Spaced role", role: " deep dive " },
    });
    expect(res.statusCode).toBe(200);
    const child = sessionManager.get((res.json() as { sessionId: string }).sessionId);
    expect(child?.originRoleName).toBe(" deep dive ");
    expect(child?.model).toBe("claude-opus-5");
  });

  it("lets a child name a COMPLETE target, which it could not do before", { timeout: 15_000 }, async () => {
    seedPinnedRole("unused");
    const parentId = await createParentSession();
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: {
        prompt: "x",
        title: "Explicit target",
        agentId: "claude",
        serviceId: "anthropic",
        billingMode: "key",
        modelId: "claude-opus-5",
        reasoningEffort: "high",
      },
    });
    expect(res.statusCode).toBe(200);
    const child = sessionManager.get((res.json() as { sessionId: string }).sessionId);
    expect(child?.serviceId).toBe("anthropic");
    expect(child?.billingMode).toBe("key");
    expect(child?.reasoningEffort).toBe("high");
    expect(child?.originRoleName).toBeUndefined();
  });

  it("refuses a complete target whose harness cannot speak to its model", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: {
        prompt: "x",
        title: "Incoherent",
        agentId: "claude",
        serviceId: "openai",
        billingMode: "sub",
        modelId: "gpt-5.6-sol",
        reasoningEffort: "high",
      },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/cannot run/);
  });

  it("files a role-started spawn's telemetry under the harness the ROLE chose", { timeout: 15_000 }, async () => {
    credentialStore.upsertCredentialRouteWithSecret(
      {
        id: "openai-key",
        serviceId: "openai",
        billingMode: "key",
        via: "string",
        status: "ready",
        priority: 0,
        isPrimary: true,
        label: "test",
        createdAt: 0,
        updatedAt: 0,
      },
      "sk-test",
    );
    credentialStore.setRole("gpt reviewer", {
      name: "gpt reviewer",
      params: {
        kind: "pinned",
        harnessId: "codex",
        serviceId: "openai",
        billingMode: "key",
        modelId: "gpt-5.6-sol",
        reasoningEffort: "high",
      },
    });
    const parentId = await createParentSession();
    resetSpawnTelemetry();
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "x", title: "Codex role", role: "gpt reviewer" },
    });
    expect(res.statusCode).toBe(200);
    expect(sessionManager.get((res.json() as { sessionId: string }).sessionId)?.agentId).toBe("codex");
    expect(getSpawnTelemetrySnapshot().byAgent.codex).toBe(1);
    expect(getSpawnTelemetrySnapshot().byAgent.claude ?? 0).toBe(0);
  });

  it("does NOT refuse a partial call over a parent — the refusal narrowed (req 16)", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();
    sessionManager.setModel(parentId, "claude-opus-4-7");
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "x", title: "Level only", reasoningEffort: "high" },
    });
    expect(res.statusCode).toBe(200);
    const child = sessionManager.get((res.json() as { sessionId: string }).sessionId);
    expect(child?.reasoningEffort).toBe("high");
    expect(child?.model).toBe("claude-opus-4-7");
  });

  it("refuses a NAMED harness level the child's model does not offer", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: {
        prompt: "x",
        title: "Bad level",
        agentId: "codex",
        serviceId: "openai",
        billingMode: "key",
        modelId: "gpt-6-astra",
        reasoningEffort: "minimal",
      },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("minimal");
  });

  it("POST /spawn rejects an unknown agent id with 400", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "x", title: "Bad agent", agent: "gpt" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("Unknown agent 'gpt'");
  });

  it("POST /spawn rejects a model that belongs to a different backend (400)", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "x", title: "Mismatch", agent: "claude", model: "gpt-5.5" },
    });
    expect(res.statusCode).toBe(400);
    const err = (res.json() as { error: string }).error;
    expect(err).toContain("gpt-5.5");
    expect(err).toContain("codex");
  });

  it("POST /spawn derives the agent from the model when --agent is omitted", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();
    expect(sessionManager.get(parentId)?.agentId ?? "claude").toBe("claude");
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "x", title: "Derive agent", model: "gpt-5.5" },
    });
    expect(res.statusCode).toBe(200);
    const childId = (res.json() as { sessionId: string }).sessionId;
    expect(sessionManager.get(childId)?.agentId).toBe("codex");
    expect(sessionManager.get(childId)?.model).toBe("gpt-5.5");
  });

  it("planning#304 — inheritance cannot hand a child a model its harness can't run", { timeout: 15_000 }, async () => {
    // Write the incoherent row directly; normal UI paths reject or repair it.
    const parentId = await createParentSession();
    sessionManager.setAgentId(parentId, "claude");
    sessionManager.setAgentPinned(parentId);
    sessionManager.setModel(parentId, "gpt-5.5");
    expect(sessionManager.get(parentId)?.model).toBe("gpt-5.5");

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "x", title: "Incoherent parent row" },
    });
    expect(res.statusCode).toBe(200);
    const childId = (res.json() as { sessionId: string }).sessionId;
    const child = (res.json() as {
      session: { model?: string; serviceId?: string; billingMode?: string };
    }).session;
    // Read the selection snapshot before turn preparation fills the live row.
    expect(sessionManager.get(childId)?.agentId).toBe("claude");
    expect(child.model).toBeUndefined();
    expect(child.serviceId).toBeUndefined();
    expect(child.billingMode).toBeUndefined();

    sessionManager.setModel(parentId, "claude-sonnet-5");
    const ok = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "x", title: "Coherent parent row" },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { session: { model?: string } }).session.model).toBe("claude-sonnet-5");

    sessionManager.setModel(parentId, "claude-opus-5-20260401");
    const fwd = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "x", title: "Unlisted parent model" },
    });
    expect(fwd.statusCode).toBe(200);
    expect((fwd.json() as { session: { model?: string } }).session.model).toBe(
      "claude-opus-5-20260401",
    );
  });

  it("GET /children/:childId surfaces the child's resolved agent + model", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();
    const spawnRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "x", title: "View agent/model", agent: "codex", model: "gpt-5.5" },
    });
    expect(spawnRes.statusCode).toBe(200);
    const childId = (spawnRes.json() as { sessionId: string }).sessionId;

    const viewRes = await app.inject({
      method: "GET",
      url: `/api/sessions/${parentId}/children/${childId}`,
    });
    expect(viewRes.statusCode).toBe(200);
    const child = (viewRes.json() as { child: { agent?: string; model?: string } }).child;
    expect(child.agent).toBe("codex");
    expect(child.model).toBe("gpt-5.5");
  });

  it("prepareSessionAgentEnvironment is idempotent: provisioning runs once, pin sticks", { timeout: 15_000 }, async () => {
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

    // Warm-up does not pin an agent; exercise turn preparation.
    await prepareSessionAgentEnvironment(runner, {
      sessionId: parentId,
      agentId: "claude",
      enforceAccountRouting: true,
      deps,
    });
    expect(sessionManager.get(parentId)?.agentPinned).toBe(true);
    expect(sessionManager.get(parentId)?.agentId).toBe("claude");

    await prepareSessionAgentEnvironment(runner, {
      sessionId: parentId,
      agentId: "claude",
      enforceAccountRouting: true,
      deps,
    });
    expect(sessionManager.get(parentId)?.agentPinned).toBe(true);

    runner.dispose();
  });

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

    const mainSha = execSync("git rev-parse origin/main", {
      cwd: parentWorkspace,
      encoding: "utf8",
    }).trim();

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

    expect(child?.warm).toBeFalsy();
    expect(child?.branchRenamed).toBe(true);
    expect(child?.parentSessionId).toBe(parentId);
    expect(child?.remoteUrl).toBe(SPAWN_REPO_URL);
  });

  it("POST /spawn never recycles a user's ungraduated /{repo}/new draft", { timeout: 30_000 }, async () => {
    const { parentId } = await claimGraduatedParent();

    await waitFor(() => !!repoStore.get(SPAWN_REPO_URL)?.warmSessionId, 10000, "warm before draft claim");
    const draftRes = await app.inject({
      method: "POST",
      url: `/api/repos/${encodeURIComponent(SPAWN_REPO_URL)}/claim-session`,
    });
    expect(draftRes.statusCode).toBe(200);
    const { sessionId: draftId } = draftRes.json() as { sessionId: string };
    expect(sessionManager.get(draftId)?.warm).toBe(true);

    await waitFor(() => !!repoStore.get(SPAWN_REPO_URL)?.warmSessionId, 10000, "re-warm after draft claim");

    const spawnRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "do the thing", title: "Do the thing" },
    });
    expect(spawnRes.statusCode).toBe(200);
    const { sessionId: childId } = spawnRes.json() as { sessionId: string };

    expect(childId).not.toBe(draftId);
    const draftAfter = sessionManager.get(draftId);
    expect(draftAfter?.warm).toBe(true);
    expect(draftAfter?.parentSessionId).toBeUndefined();
    expect(sessionManager.get(childId)?.workspaceDir).not.toBe(draftAfter?.workspaceDir);
  });

  it("POST /spawn rejects a parent with no registered remote URL", { timeout: 15_000 }, async () => {
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

  it("POST /spawn refuses a sandbox parent with a sandbox-specific reason", { timeout: 15_000 }, async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/_test/sessions",
      payload: { title: "Sandbox" },
    });
    const { sessionId: parentId } = res.json() as { sessionId: string };
    sessionManager.setKind(parentId, "sandbox");

    const spawnRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "spin up a sibling", title: "Sibling" },
    });
    expect(spawnRes.statusCode).toBe(400);
    const error = spawnRes.json().error as string;
    expect(error).toMatch(/sandbox/i);
    expect(error).not.toMatch(/no remote URL/i);
    expect(error).toMatch(/shipit agent run/);
  });

  it("POST /spawn --detached also refuses a sandbox parent", { timeout: 15_000 }, async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/_test/sessions",
      payload: { title: "Sandbox" },
    });
    const { sessionId: parentId } = res.json() as { sessionId: string };
    sessionManager.setKind(parentId, "sandbox");

    const spawnRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "spin up a sibling", title: "Sibling", detached: true },
    });
    expect(spawnRes.statusCode).toBe(400);
    expect(spawnRes.json().error).toMatch(/sandbox/i);
  });

  it("POST /spawn --detached creates a session with NO parent/root linkage", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "Fix an unrelated bug", title: "Unrelated fix", detached: true, spawnedByTurn: "turn-1" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      sessionId: string;
      session: { parentSessionId?: string; rootSessionId?: string; spawnedByTurn?: string };
    };
    expect(body.session.parentSessionId).toBeUndefined();
    expect(body.session.rootSessionId).toBeUndefined();

    const reloaded = sessionManager.get(body.sessionId);
    expect(reloaded?.parentSessionId).toBeUndefined();
    expect(reloaded?.rootSessionId).toBeUndefined();
    expect(reloaded?.spawnedByTurn).toBe("turn-1");
  });

  it("a detached session is absent from the parent's children and uncoordinatable", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "Fix an unrelated bug", title: "Unrelated fix", detached: true },
    });
    const { sessionId: detachedId } = res.json() as { sessionId: string };

    const list = await app.inject({ method: "GET", url: `/api/sessions/${parentId}/children` });
    expect((list.json().children as unknown[]).length).toBe(0);

    const view = await app.inject({ method: "GET", url: `/api/sessions/${parentId}/children/${detachedId}` });
    expect(view.statusCode).toBe(404);
  });

  it("a detached spawn emits NO session_spawned card in the parent chat", { timeout: 15_000 }, async () => {
    const parentId = await createParentSession();
    const parentClient = await TestClient.connect(port, parentId);

    try {
      // Use the next linked child's card to bound the check for an unwanted detached card.
      const detached = await app.inject({
        method: "POST",
        url: `/api/sessions/${parentId}/spawn`,
        payload: { prompt: "unrelated", title: "Detached one", detached: true },
      });
      expect(detached.statusCode).toBe(200);
      const detachedId = (detached.json() as { sessionId: string }).sessionId;

      const child = await app.inject({
        method: "POST",
        url: `/api/sessions/${parentId}/spawn`,
        payload: { prompt: "related work", title: "Real child" },
      });
      expect(child.statusCode).toBe(200);
      const childId = (child.json() as { sessionId: string }).sessionId;

      const spawnedMsg = await parentClient.receiveType("session_spawned", 5000) as {
        childSessionId: string;
        title: string;
      };
      expect(spawnedMsg.childSessionId).toBe(childId);
      expect(spawnedMsg.title).toBe("Real child");
      expect(spawnedMsg.childSessionId).not.toBe(detachedId);
    } finally {
      parentClient.close();
    }
  });

  it("detached spawns count against the per-turn cap (alongside linked children)", { timeout: 30_000 }, async () => {
    const parentId = await createParentSession();

    const linkedCount = Math.floor(DEFAULT_MAX_SPAWNED_SESSIONS_PER_TURN / 2);
    const detachedCount = DEFAULT_MAX_SPAWNED_SESSIONS_PER_TURN - linkedCount;
    for (let i = 0; i < linkedCount; i++) {
      const linked = await app.inject({
        method: "POST",
        url: `/api/sessions/${parentId}/spawn`,
        payload: { prompt: `linked-${i}`, title: `Linked ${i}`, spawnedByTurn: "turn-1" },
      });
      expect(linked.statusCode).toBe(200);
    }
    for (let i = 0; i < detachedCount; i++) {
      const det = await app.inject({
        method: "POST",
        url: `/api/sessions/${parentId}/spawn`,
        payload: { prompt: `detached-${i}`, title: `Detached ${i}`, detached: true, spawnedByTurn: "turn-1" },
      });
      expect(det.statusCode).toBe(200);
    }

    const limited = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "detached-over-cap", title: "Detached over cap", detached: true, spawnedByTurn: "turn-1" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toContain("Per-turn spawn limit");
  });
});
