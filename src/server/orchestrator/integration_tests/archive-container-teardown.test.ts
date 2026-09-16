import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { GitManager } from "../../shared/git.js";
import { DatabaseManager } from "../../shared/database.js";
import { SessionContainerManager } from "../session-container.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { allocateDeadLoopbackPort, waitFor } from "./container-test-helpers.js";

function createFakeDocker() {
  let counter = 0;
  const containers = new Map<string, { id: string; started: boolean; labels: Record<string, string> }>();

  return {
    _containers: containers,
    ping: async () => "OK",
    createNetwork: async () => ({ id: "net-fake" }),
    getNetwork: () => ({ inspect: async () => { throw new Error("not found"); }, remove: async () => {} }),
    listNetworks: async () => [],
    listVolumes: async () => ({ Volumes: [] }),
    createContainer: async (opts: { Labels?: Record<string, string> }) => {
      counter++;
      const id = `fake-container-${counter}`;
      const ip = `127.0.0.${counter + 2}`;
      containers.set(id, { id, started: false, labels: opts.Labels ?? {} });
      return {
        id,
        start: async () => { containers.get(id)!.started = true; },
        inspect: async () => ({ id, NetworkSettings: { Networks: { "shipit-test": { IPAddress: ip } } } }),
        stop: async () => { const c = containers.get(id); if (c) c.started = false; },
        remove: async () => { containers.delete(id); },
      };
    },
    getContainer: (id: string) => ({
      stop: async () => { const c = containers.get(id); if (c) c.started = false; },
      remove: async () => { containers.delete(id); },
    }),
    listContainers: async () =>
      [...containers.values()].map((c) => ({ Id: c.id, Labels: c.labels, State: c.started ? "running" : "exited" })),
    getEvents: async () => new EventEmitter(),
  };
}

describe("Integration: archiving tears the agent container down", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let containerManager: SessionContainerManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-archive-teardown-"));
    sessionManager = new SessionManager(dbManager);
    chatHistoryManager = new ChatHistoryManager(dbManager);

    containerManager = new SessionContainerManager({
      docker: createFakeDocker() as never,
      imageName: "shipit-session-worker:test",
      networkName: "shipit-test",
      workerPort: await allocateDeadLoopbackPort(),
      skipHealthCheck: true,
      stackName: "shipit-test",
    });

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => new FakeClaudeProcess() as never,
      workspaceDir: tmpDir,
      credentialsDir: tmpDir,
      serveStatic: false,
      sessionContainerManager: containerManager,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  async function createSession(): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/api/_test/sessions", payload: { title: "Archive test" } });
    expect(res.statusCode).toBe(200);
    return (res.json() as { sessionId: string }).sessionId;
  }

  it("destroys the fork's container when recovering a rewind archives it", async () => {
    const sessionId = await createSession();
    chatHistoryManager.append(sessionId, { role: "user", text: "keep" });
    chatHistoryManager.append(sessionId, { role: "assistant", text: "kept response" });

    const client = await TestClient.connect(port, sessionId);
    await client.receiveType("preview_status");

    client.send({ type: "rewind_at_gap", gapPosition: 2, action: "fork", sessionName: "Undo fork" });
    const forked = await client.receiveType("session_forked");
    if (forked.type !== "session_forked") throw new Error("Expected session_forked");
    const childId = forked.childSessionId;

    // The child only leaks a container once it has one, which is what activating it does.
    const childClient = await TestClient.connect(port, childId);
    await waitFor(() => containerManager.get(childId) !== undefined, 5000, "child container");
    childClient.close();

    client.send({ type: "rewind_restore_request", sessionId });
    await expect(client.receiveType("rewind_restored")).resolves.toMatchObject({
      action: "fork",
      archivedSessionId: childId,
    });

    expect(sessionManager.get(childId)?.archived).toBe(true);
    await waitFor(() => containerManager.get(childId) === undefined, 5000, "child container destroyed");

    client.close();
  });
});
