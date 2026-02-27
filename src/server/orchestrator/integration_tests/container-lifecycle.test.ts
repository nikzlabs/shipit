/**
 * Integration tests for Docker container lifecycle wiring in buildApp().
 *
 * Validates that when a SessionContainerManager is injected, the runner
 * factory creates ContainerSessionRunner instances backed by containers.
 * Uses a fake Docker client to avoid real Docker.
 */

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
} from "./test-helpers.js";
import type { AuthManager } from "../auth.js";
import type { ClaudeProcess } from "../../session/claude.js";
import type { FastifyInstance } from "fastify";

// ---------------------------------------------------------------------------
// Fake Docker (minimal mock for SessionContainerManager)
// ---------------------------------------------------------------------------

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
      const ip = `172.18.0.${containerCounter + 2}`;
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a session directory + git repo and track it in the session manager. */
async function createSession(
  sessionManager: SessionManager,
  sessionsDir: string,
  title: string,
): Promise<{ id: string; dir: string }> {
  const id = `test-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(sessionsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const git = new GitManager(dir);
  await git.init();
  sessionManager.track(id, title, dir);
  return { id, dir };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("container lifecycle integration", () => {
  let tmpDir: string;
  let sessionsDir: string;
  let app: FastifyInstance;
  let port: number;
  let sessionManager: SessionManager;
  let containerManager: SessionContainerManager;
  let fakeDocker: ReturnType<typeof createFakeDocker>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-container-lifecycle-"));
    sessionsDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });

    sessionManager = new SessionManager(path.join(tmpDir, "sessions.json"));

    fakeDocker = createFakeDocker();
    containerManager = new SessionContainerManager({
      docker: fakeDocker as any,
      imageName: "shipit-session-worker:test",
      networkName: "shipit-test",
      workerPort: 9100,
      skipHealthCheck: true,
      stackName: "shipit-test",
    });

    // Pass createPreviewManager and createFileWatcher as factories so that
    // runners are created eagerly on activate_session (production behavior).
    app = await buildApp({
      workspaceDir: tmpDir,
      credentialsDir: tmpDir,
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      claudeFactory: () => new FakeClaudeProcess() as unknown as ClaudeProcess,
      serveStatic: false,
      sessionContainerManager: containerManager,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = address.match(/:(\d+)$/);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    await app.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("creates a Docker container when a session is activated", async () => {
    const { id: sessionId } = await createSession(sessionManager, sessionsDir, "Container Test");

    const client = await TestClient.connect(port);
    // Drain initial messages
    try { while (true) await client.receive(200); } catch { /* done */ }

    // Activate the session — this should trigger runner creation → container creation
    client.send({ type: "activate_session", sessionId });
    // Wait for activation + async container creation
    await new Promise((r) => setTimeout(r, 500));

    // A container should have been created in the fake Docker
    const sc = containerManager.get(sessionId);
    expect(sc).toBeDefined();
    expect(sc!.status).toBe("running");
    expect(sc!.containerIp).toMatch(/^172\.18\.0\.\d+$/);
    expect(sc!.workerUrl).toMatch(/^http:\/\/172\.18\.0\.\d+:9100$/);

    // The Docker container should be started
    const dockerContainer = [...fakeDocker._containers.values()].find(
      (c) => c.labels[CONTAINER_SESSION_ID_LABEL] === sessionId,
    );
    expect(dockerContainer).toBeDefined();
    expect(dockerContainer!.started).toBe(true);

    client.close();
  });

  it("destroys containers when app shuts down", async () => {
    const { id: sessionId } = await createSession(sessionManager, sessionsDir, "Shutdown Test");

    const client = await TestClient.connect(port);
    try { while (true) await client.receive(200); } catch { /* done */ }

    client.send({ type: "activate_session", sessionId });
    await new Promise((r) => setTimeout(r, 500));

    expect(containerManager.size).toBeGreaterThanOrEqual(1);

    client.close();
    await new Promise((r) => setTimeout(r, 100));

    // Closing the app should clean up containers via dispose
    await app.close();
    expect(containerManager.size).toBe(0);
  });

  it("orphan cleanup removes stale containers", async () => {
    // Simulate an orphan container from a previous orchestrator run
    await containerManager.create({
      sessionId: "orphan-session",
      sessionDir: "/workspace/sessions/orphan",
      credentialsDir: "/credentials",
      imageName: "shipit-session-worker:test",
      memoryLimit: 512 * 1024 * 1024,
      cpuQuota: 50_000,
      pidsLimit: 256,
    });
    expect(containerManager.size).toBe(1);

    // Clean up orphans — orphan-session is not tracked by sessionManager
    const removed = await containerManager.cleanupOrphans(new Set());
    expect(removed).toBe(1);
  });

  it("emits container_exited when Docker reports a die event", async () => {
    const { id: sessionId } = await createSession(sessionManager, sessionsDir, "Health Test");

    const client = await TestClient.connect(port);
    try { while (true) await client.receive(200); } catch { /* done */ }

    client.send({ type: "activate_session", sessionId });
    await new Promise((r) => setTimeout(r, 500));

    expect(containerManager.get(sessionId)).toBeDefined();

    // Start health monitor to listen for Docker events
    await containerManager.startHealthMonitor();

    // Simulate a Docker "die" event
    fakeDocker._eventEmitter.emit("data", Buffer.from(JSON.stringify({
      Action: "die",
      Actor: {
        Attributes: {
          [CONTAINER_SESSION_ID_LABEL]: sessionId,
          exitCode: "137",
        },
      },
    })));

    // Container should be removed from the manager
    expect(containerManager.get(sessionId)).toBeUndefined();

    client.close();
  });

  it("multiple sessions get separate containers", async () => {
    const { id: session1 } = await createSession(sessionManager, sessionsDir, "Session 1");
    const { id: session2 } = await createSession(sessionManager, sessionsDir, "Session 2");

    const client = await TestClient.connect(port);
    try { while (true) await client.receive(200); } catch { /* done */ }

    // Activate session 1
    client.send({ type: "activate_session", sessionId: session1 });
    await new Promise((r) => setTimeout(r, 500));

    // Activate session 2
    client.send({ type: "activate_session", sessionId: session2 });
    await new Promise((r) => setTimeout(r, 500));

    const sc1 = containerManager.get(session1);
    const sc2 = containerManager.get(session2);

    expect(sc1).toBeDefined();
    expect(sc2).toBeDefined();
    expect(sc1!.containerIp).not.toBe(sc2!.containerIp);
    expect(sc1!.id).not.toBe(sc2!.id);

    client.close();
  });
});
