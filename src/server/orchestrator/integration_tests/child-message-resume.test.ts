/**
 * Regression tests for the agent-driven child-message container-resume bug
 * (Ops docs/162 follow-up).
 *
 * Symptom in prod: a `shipit session message` sent to a spawned child whose
 * container had been idle-reaped printed `delivered: starting turn`, but the
 * agent never reacted — the turn was dispatched into a dead/absent worker and
 * silently dropped, while the shim had already reported success.
 *
 * Two distinct post-reap states must both resume:
 *
 *   1. Runner disposed + container destroyed (the common idle-enforcer path):
 *      `getOrCreate` builds a fresh runner and the registry factory boots a new
 *      container. This already worked; the test guards against regression.
 *
 *   2. Container destroyed but the runner SURVIVES in the registry (eviction
 *      race, missed Docker `die`, external `docker rm`): `getOrCreate` would
 *      hand back the stale, container-less runner and `dispatch()` would fire
 *      into the void. `sendChildMessage` now detects the dead container and
 *      disposes the stale runner so a fresh container boots.
 *
 * And the false-ack: when the container fails to boot, the request must fail
 * loudly (5xx) rather than reporting a phantom "starting turn".
 *
 * Uses a fake Docker client (no real Docker) — the assertions are on container
 * creation count and HTTP status, not on agent execution (there is no real
 * worker behind the fake container IPs).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../index.js";
import { SessionManager } from "../sessions.js";
import { GitManager } from "../../shared/git.js";
import { SessionContainerManager } from "../session-container.js";
import { DatabaseManager } from "../../shared/database.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import {
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

// generateSessionName forks a real CLI; stub to a no-op (mirrors
// agent-spawned-session.test.ts).
vi.mock("../session-namer.js", () => ({
  generateSessionName: vi.fn().mockResolvedValue(null),
}));

// ---------------------------------------------------------------------------
// Fake Docker (minimal mock for SessionContainerManager) — mirrors the harness
// in container-lifecycle.test.ts, plus a `failCreateAfter` knob so a test can
// simulate a container that fails to boot.
// ---------------------------------------------------------------------------

function createFakeDocker(opts: { failCreateAfter?: number } = {}) {
  let containerCounter = 0;
  const containers = new Map<string, { id: string; started: boolean; labels: Record<string, string>; ip: string }>();
  const eventEmitter = new EventEmitter();

  return {
    _containers: containers,
    _eventEmitter: eventEmitter,
    _createCount: () => containerCounter,

    ping: async () => "OK",
    createNetwork: async () => ({ id: "net-fake" }),
    getNetwork: () => ({ inspect: async () => { throw new Error("not found"); } }),

    createContainer: async (createOpts: any) => {
      containerCounter++;
      if (opts.failCreateAfter !== undefined && containerCounter > opts.failCreateAfter) {
        throw new Error("simulated container boot failure");
      }
      const id = `fake-container-${containerCounter}`;
      const ip = `172.18.0.${containerCounter + 2}`;
      containers.set(id, { id, started: false, labels: createOpts.Labels ?? {}, ip });
      return {
        id,
        start: async () => { containers.get(id)!.started = true; },
        inspect: async () => ({ id, NetworkSettings: { Networks: { "shipit-test": { IPAddress: ip } } } }),
        stop: async () => { if (containers.has(id)) containers.get(id)!.started = false; },
        remove: async () => { containers.delete(id); },
      };
    },

    getContainer: (id: string) => ({
      stop: async () => { if (containers.has(id)) containers.get(id)!.started = false; },
      remove: async () => { containers.delete(id); },
    }),

    listContainers: async () =>
      [...containers.values()].map((c) => ({ Id: c.id, Labels: c.labels, State: c.started ? "running" : "exited" })),

    getEvents: async () => eventEmitter,
  };
}

describe("Integration: child-message container resume (Ops docs/162 follow-up)", () => {
  let tmpDir: string;
  let app: FastifyInstance;
  let sessionManager: SessionManager;
  let containerManager: SessionContainerManager;
  let fakeDocker: ReturnType<typeof createFakeDocker>;
  let dbManager: DatabaseManager;

  async function buildAppWith(docker: ReturnType<typeof createFakeDocker>): Promise<void> {
    fakeDocker = docker;
    containerManager = new SessionContainerManager({
      docker: fakeDocker as any,
      imageName: "shipit-session-worker:test",
      networkName: "shipit-test",
      workerPort: 9100,
      skipHealthCheck: true,
      stackName: "shipit-test",
    });
    app = await buildApp({
      workspaceDir: tmpDir,
      credentialsDir: tmpDir,
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
      serveStatic: false,
      sessionContainerManager: containerManager,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
  }

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-child-resume-"));
    fs.mkdirSync(path.join(tmpDir, "sessions"), { recursive: true });
    sessionManager = new SessionManager(dbManager);
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {
      // ignore cleanup errors
    }
  });

  /** Create a session dir + git repo and track it. */
  async function mkSession(id: string, title: string): Promise<string> {
    const dir = path.join(tmpDir, "sessions", id, "workspace");
    fs.mkdirSync(dir, { recursive: true });
    const git = new GitManager(dir);
    await git.init();
    sessionManager.track(id, title, dir);
    return dir;
  }

  /** Stand up a parent + child (linked) and prime the child's first turn (which
   *  boots its first container). Returns ids. */
  async function setupParentAndChild(): Promise<{ parentId: string; childId: string }> {
    const parentId = "parent-1";
    const childId = "child-1";
    await mkSession(parentId, "Parent");
    await mkSession(childId, "Child");
    sessionManager.setParentSession(childId, parentId);

    const first = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/children/${childId}/message`,
      payload: { text: "first turn" },
    });
    expect(first.statusCode).toBe(200);
    // Let the registry factory's fire-and-forget container create settle.
    await new Promise((r) => setTimeout(r, 300));
    expect(fakeDocker._createCount()).toBe(1);
    expect(containerManager.get(childId)?.status).toBe("running");
    return { parentId, childId };
  }

  it("resumes a fresh container when the runner survives but its container was reaped", async () => {
    await buildAppWith(createFakeDocker());
    const { parentId, childId } = await setupParentAndChild();

    // Reap the container WITHOUT disposing the runner (the eviction-race /
    // missed-die state). The runner now points at a dead worker.
    await containerManager.destroy(childId);
    expect(containerManager.get(childId)).toBeUndefined();

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/children/${childId}/message`,
      payload: { text: "resume me" },
    });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 300));

    // A SECOND container was booted (the stale runner was torn down and
    // re-created) — before the fix this stayed at 1 and the message was
    // silently dropped.
    expect(fakeDocker._createCount()).toBe(2);
    expect(containerManager.get(childId)?.status).toBe("running");
  });

  it("resumes a fresh container after a full idle reap (runner disposed + container destroyed)", async () => {
    await buildAppWith(createFakeDocker());
    const { parentId, childId } = await setupParentAndChild();

    // Exact idle-enforcer order: dispose the runner, then destroy the container.
    await app.inject({ method: "POST", url: `/api/_test/dispose-runner/${childId}` });
    await containerManager.destroy(childId);
    expect(containerManager.get(childId)).toBeUndefined();

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/children/${childId}/message`,
      payload: { text: "resume after idle" },
    });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 300));

    expect(fakeDocker._createCount()).toBe(2);
    expect(containerManager.get(childId)?.status).toBe("running");
  });

  it("fails loudly (does not falsely ack) when the resumed container cannot boot", async () => {
    // First container boots fine; the resume boot (2nd create) fails.
    await buildAppWith(createFakeDocker({ failCreateAfter: 1 }));
    const { parentId, childId } = await setupParentAndChild();

    // Reap the container, runner survives.
    await containerManager.destroy(childId);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/children/${childId}/message`,
      payload: { text: "this should fail loudly" },
    });

    // The boot failed → the request reports an error rather than "starting
    // turn". The shim surfaces this as a failure (exit 1) instead of a phantom
    // success.
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/could not resume/i);
  });
});
