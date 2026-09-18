import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { buildApp } from "../index.js";
import { SessionManager } from "../sessions.js";
import { GitManager } from "../../shared/git.js";
import { SessionContainerManager, CONTAINER_SESSION_ID_LABEL } from "../session-container.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { allocateDeadLoopbackPort } from "./container-test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import type { FastifyInstance } from "fastify";

function createFakeDocker() {
  let containerCounter = 0;
  const containers = new Map<string, { id: string; started: boolean; labels: Record<string, string>; ip: string }>();
  const eventEmitter = new EventEmitter();

  return {
    _containers: containers,
    _eventEmitter: eventEmitter,

    ping: async () => "OK",

    createNetwork: async () => ({ id: "net-fake" }),

    getNetwork: () => ({
      inspect: async () => { throw new Error("not found"); },
    }),

    createContainer: async (opts: any) => {
      containerCounter++;
      const id = `fake-container-${containerCounter}`;
      const ip = `127.0.0.${containerCounter + 2}`;
      containers.set(id, { id, started: false, labels: opts.Labels ?? {}, ip });

      return {
        id,
        start: async () => { containers.get(id)!.started = true; },
        inspect: async () => ({
          id,
          NetworkSettings: {
            Networks: { "shipit-test": { IPAddress: ip } },
          },
        }),
        stop: async () => { if (containers.has(id)) containers.get(id)!.started = false; },
        remove: async () => { containers.delete(id); },
      };
    },

    getContainer: (id: string) => ({
      stop: async () => { if (containers.has(id)) containers.get(id)!.started = false; },
      remove: async () => { containers.delete(id); },
    }),

    listContainers: async () =>
      [...containers.values()]
        .map((c) => ({ Id: c.id, Labels: c.labels, State: c.started ? "running" : "exited" })),

    getEvents: async () => eventEmitter,
  };
}

// Container state lookup requires the sessionDir/workspace layout.
async function createSession(
  sessionManager: SessionManager,
  sessionsDir: string,
  title: string,
): Promise<{ id: string; dir: string }> {
  const id = `test-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(sessionsDir, id, "workspace");
  fs.mkdirSync(dir, { recursive: true });
  const git = new GitManager(dir);
  await git.init();
  sessionManager.track(id, title, dir);
  return { id, dir };
}

describe("container lifecycle integration", () => {
  let tmpDir: string;
  let sessionsDir: string;
  let app: FastifyInstance;
  let port: number;
  let sessionManager: SessionManager;
  let containerManager: SessionContainerManager;
  let fakeDocker: ReturnType<typeof createFakeDocker>;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-container-lifecycle-"));
    sessionsDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });

    sessionManager = new SessionManager(dbManager);

    fakeDocker = createFakeDocker();
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
      // Ignore cleanup errors
    }
  });

  it("creates a Docker container when a session is activated", async () => {
    const { id: sessionId } = await createSession(sessionManager, sessionsDir, "Container Test");

    const client = await TestClient.connect(port, sessionId);
    await new Promise((r) => setTimeout(r, 500));

    const sc = containerManager.get(sessionId);
    expect(sc).toBeDefined();
    expect(sc!.status).toBe("running");
    expect(sc!.containerIp).toMatch(/^127\.0\.0\.\d+$/);
    expect(sc!.workerUrl).toMatch(/^http:\/\/127\.0\.0\.\d+:\d+$/);

    const dockerContainer = [...fakeDocker._containers.values()].find(
      (c) => c.labels[CONTAINER_SESSION_ID_LABEL] === sessionId,
    );
    expect(dockerContainer).toBeDefined();
    expect(dockerContainer!.started).toBe(true);

    client.close();
  });

  it("leaves containers running when the app shuts down", async () => {
    const { id: sessionId } = await createSession(sessionManager, sessionsDir, "Shutdown Test");

    const client = await TestClient.connect(port, sessionId);
    await new Promise((r) => setTimeout(r, 500));

    expect(containerManager.size).toBeGreaterThanOrEqual(1);
    const before = [...fakeDocker._containers.keys()];
    expect(before.length).toBeGreaterThanOrEqual(1);

    client.close();
    await new Promise((r) => setTimeout(r, 100));

    await app.close();

    expect([...fakeDocker._containers.keys()]).toEqual(before);
    expect([...fakeDocker._containers.values()].every((c) => c.started)).toBe(true);
    expect(containerManager.size).toBeGreaterThanOrEqual(1);
    expect(containerManager.get(sessionId)?.status).toBe("running");
  });

  it("orphan cleanup removes stale containers", async () => {
    const orphanDir = path.join(sessionsDir, "orphan");
    await containerManager.create({
      sessionId: "orphan-session",
      sessionDir: orphanDir,
      workspaceDir: path.join(orphanDir, "workspace"),
      sessionStateDir: path.join(orphanDir, "state"),
      credentialsDir: tmpDir,
      imageName: "shipit-session-worker:test",
      memoryLimit: 512 * 1024 * 1024,
      cpuQuota: 50_000,
      pidsLimit: 256,
    });
    expect(containerManager.size).toBe(1);

    const removed = await containerManager.cleanupOrphans(new Set());
    expect(removed).toBe(1);
  });

  it("emits container_exited when Docker reports a die event", async () => {
    const { id: sessionId } = await createSession(sessionManager, sessionsDir, "Health Test");

    const client = await TestClient.connect(port, sessionId);
    await new Promise((r) => setTimeout(r, 500));

    expect(containerManager.get(sessionId)).toBeDefined();

    await containerManager.startHealthMonitor();

    fakeDocker._eventEmitter.emit("data", Buffer.from(JSON.stringify({
      Action: "die",
      Actor: {
        Attributes: {
          [CONTAINER_SESSION_ID_LABEL]: sessionId,
          exitCode: "137",
        },
      },
    })));

    expect(containerManager.get(sessionId)).toBeUndefined();

    client.close();
  });

  it("multiple sessions get separate containers", async () => {
    const { id: session1 } = await createSession(sessionManager, sessionsDir, "Session 1");
    const { id: session2 } = await createSession(sessionManager, sessionsDir, "Session 2");

    const client1 = await TestClient.connect(port, session1);
    await new Promise((r) => setTimeout(r, 500));

    const client2 = await TestClient.connect(port, session2);
    await new Promise((r) => setTimeout(r, 500));

    const sc1 = containerManager.get(session1);
    const sc2 = containerManager.get(session2);

    expect(sc1).toBeDefined();
    expect(sc2).toBeDefined();
    expect(sc1!.containerIp).not.toBe(sc2!.containerIp);
    expect(sc1!.id).not.toBe(sc2!.id);

    client1.close();
    client2.close();
  });

  it("creates fresh container after container crash and reactivation", async () => {
    const { id: sessionId } = await createSession(sessionManager, sessionsDir, "Crash Recovery");

    const client1 = await TestClient.connect(port, sessionId);
    await new Promise((r) => setTimeout(r, 500));

    const sc1 = containerManager.get(sessionId);
    expect(sc1).toBeDefined();
    const originalId = sc1!.id;

    await containerManager.startHealthMonitor();
    fakeDocker._eventEmitter.emit("data", Buffer.from(JSON.stringify({
      Action: "die",
      Actor: {
        Attributes: {
          [CONTAINER_SESSION_ID_LABEL]: sessionId,
          exitCode: "137",
        },
      },
    })));

    expect(containerManager.get(sessionId)).toBeUndefined();

    client1.close();
    await new Promise((r) => setTimeout(r, 100));

    const client2 = await TestClient.connect(port, sessionId);
    await new Promise((r) => setTimeout(r, 500));

    const sc2 = containerManager.get(sessionId);
    expect(sc2).toBeDefined();
    expect(sc2!.status).toBe("running");
    expect(sc2!.id).not.toBe(originalId);

    client2.close();
  });
});

describe("container reconnect on re-activation", () => {
  let tmpDir: string;
  let sessionsDir: string;
  let app: FastifyInstance;
  let port: number;
  let sessionManager: SessionManager;
  let containerManager: SessionContainerManager;
  let fakeDocker: ReturnType<typeof createFakeDocker>;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-container-reconnect-"));
    sessionsDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });

    sessionManager = new SessionManager(dbManager);

    fakeDocker = createFakeDocker();
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
      // Ignore cleanup errors
    }
  });

  it("reconnects to existing container after disconnect and reconnect", async () => {
    const { id: sessionId } = await createSession(sessionManager, sessionsDir, "Reconnect Test");

    const client1 = await TestClient.connect(port, sessionId);
    await new Promise((r) => setTimeout(r, 500));

    const sc = containerManager.get(sessionId);
    expect(sc).toBeDefined();
    expect(sc!.status).toBe("running");
    const originalContainerId = sc!.id;
    const originalWorkerUrl = sc!.workerUrl;

    client1.close();
    await new Promise((r) => setTimeout(r, 200));

    expect(containerManager.get(sessionId)).toBeDefined();
    expect(containerManager.get(sessionId)!.status).toBe("running");

    const client2 = await TestClient.connect(port, sessionId);
    await new Promise((r) => setTimeout(r, 500));

    const sc2 = containerManager.get(sessionId);
    expect(sc2).toBeDefined();
    expect(sc2!.id).toBe(originalContainerId);
    expect(sc2!.workerUrl).toBe(originalWorkerUrl);

    const matchingContainers = [...fakeDocker._containers.values()].filter(
      (c) => c.labels[CONTAINER_SESSION_ID_LABEL] === sessionId,
    );
    expect(matchingContainers).toHaveLength(1);

    client2.close();
  });
});
