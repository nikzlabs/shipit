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
import { allocateDeadLoopbackPort } from "./container-test-helpers.js";

// Prevent a real naming CLI from starting.
vi.mock("../session-namer.js", () => ({
  generateSessionName: vi.fn().mockResolvedValue({ name: null }),
}));

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
      // Use the allocated dead port; port 9100 can target this session's live worker.
      const ip = "127.0.0.1";
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
      workerPort: await allocateDeadLoopbackPort(),
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

  async function mkSession(id: string, title: string): Promise<string> {
    const dir = path.join(tmpDir, "sessions", id, "workspace");
    fs.mkdirSync(dir, { recursive: true });
    const git = new GitManager(dir);
    await git.init();
    sessionManager.track(id, title, dir);
    return dir;
  }

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
    await new Promise((r) => setTimeout(r, 300));
    expect(fakeDocker._createCount()).toBe(1);
    expect(containerManager.get(childId)?.status).toBe("running");
    return { parentId, childId };
  }

  it("resumes a fresh container when the runner survives but its container was reaped", { timeout: 15_000 }, async () => {
    await buildAppWith(createFakeDocker());
    const { parentId, childId } = await setupParentAndChild();

    await containerManager.destroy(childId);
    expect(containerManager.get(childId)).toBeUndefined();

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/children/${childId}/message`,
      payload: { text: "resume me" },
    });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 300));

    expect(fakeDocker._createCount()).toBe(2);
    expect(containerManager.get(childId)?.status).toBe("running");
  });

  it("resumes a fresh container after a full idle reap (runner disposed + container destroyed)", { timeout: 15_000 }, async () => {
    await buildAppWith(createFakeDocker());
    const { parentId, childId } = await setupParentAndChild();

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

  it("fails loudly (does not falsely ack) when the resumed container cannot boot", { timeout: 15_000 }, async () => {
    await buildAppWith(createFakeDocker({ failCreateAfter: 1 }));
    const { parentId, childId } = await setupParentAndChild();

    await containerManager.destroy(childId);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/children/${childId}/message`,
      payload: { text: "this should fail loudly" },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/could not resume/i);
  });
});
