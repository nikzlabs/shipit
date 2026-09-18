import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const finalizeAgentEnvSpy = vi.fn();
vi.mock("../session-agent-env.js", async (importOriginal) => {
  const mod = await importOriginal() as Record<string, unknown>;
  const real = mod.finalizeSessionAgentEnvironment as (...args: unknown[]) => void;
  return {
    ...mod,
    finalizeSessionAgentEnvironment: (...args: unknown[]) => {
      finalizeAgentEnvSpy(...args);
      real(...args);
    },
  };
});

import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";


import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

type AnyMsg = any;

describe("Integration: prompt queuing", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let lastClaude: FakeClaudeProcess = null as any;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-queue-"));

    sessionManager = new SessionManager(dbManager);
    chatHistoryManager = new ChatHistoryManager(dbManager);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as any;
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
      // Ignore cleanup errors
    }
  });

  async function waitForAgentIdle(sessionId: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
      if ((res.json() as { agentRunning?: boolean }).agentRunning === false) return;
      if (Date.now() > deadline) throw new Error("agent still running after timeout");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async function drainUntil(client: TestClient, predicate: (m: AnyMsg) => boolean, maxMsgs = 30, timeoutMs = 2000): Promise<AnyMsg> {
    for (let i = 0; i < maxMsgs; i++) {
      const msg: AnyMsg = await client.receive(timeoutMs);
      if (predicate(msg)) return msg;
    }
    return null;
  }

  it("queues a second message while the first is running and returns message_queued", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "First message" });
    const firstClaude = await waitForClaude(() => lastClaude);
    expect(firstClaude.lastPrompt).toBe("First message");

    client.send({ type: "send_message", text: "Second message" });

    const queued = await drainUntil(client, (m) => m.type === "message_queued");

    expect(queued).toMatchObject({
      type: "message_queued",
      position: 1,
      text: "Second message",
    });

    expect(lastClaude).toBe(firstClaude);

    client.close();
  });

  it("tears the turn down on auth_required (kills agent, clears running)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "go" });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "agent_init", sessionId: "s-auth", model: "m", tools: [] });

    claude.emit("auth_required");

    const authMsg = await drainUntil(client, (m) => m.type === "error");
    expect((authMsg as { message?: string })?.message).toContain("Settings");
    expect(claude.killed).toBe(true);
    const status = await drainUntil(client, (m) => m.type === "session_status");
    expect(status).toMatchObject({ type: "session_status", running: false });

    client.close();
  });

  it("dequeues and executes the next message after Claude finishes", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "First" });
    const firstClaude = await waitForClaude(() => lastClaude);

    firstClaude.emit("event", {
      type: "agent_init",
      sessionId: "session-a",
      model: "claude-3-5-sonnet",
      tools: [],
    });

    client.send({ type: "send_message", text: "Second" });

    const queued = await drainUntil(client, (m) => m.type === "message_queued");
    expect(queued?.type).toBe("message_queued");

    firstClaude.emit("event", { type: "agent_result", status: "success", sessionId: "session-a", durationMs: 100 });
    firstClaude.emit("done", 0);

    const secondClaude = await waitForClaude(() => lastClaude, firstClaude);
    expect(secondClaude.lastPrompt).toBe("Second");
    expect(secondClaude).not.toBe(firstClaude);

    const queueUpdated = await drainUntil(client, (m) => m.type === "queue_updated", 30, 3000);
    expect(queueUpdated).toMatchObject({ type: "queue_updated", queue: [] });

    client.close();
  });

  it("sends an empty queue_updated on re-attach after the queue drained while detached", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive();
    const sessionId = client1.sessionId;

    client1.send({ type: "send_message", text: "First" });
    const firstClaude = await waitForClaude(() => lastClaude);
    firstClaude.emit("event", { type: "agent_init", sessionId: "session-drain", model: "m", tools: [] });

    client1.send({ type: "send_message", text: "Second" });
    expect(await drainUntil(client1, (m) => m.type === "message_queued")).toBeTruthy();
    client1.close();
    await new Promise((r) => setTimeout(r, 50));

    firstClaude.emit("event", { type: "agent_result", status: "success", sessionId: "session-drain", durationMs: 10 });
    firstClaude.emit("done", 0);
    const secondClaude = await waitForClaude(() => lastClaude, firstClaude);
    expect(secondClaude.lastPrompt).toBe("Second");

    secondClaude.emit("event", { type: "agent_result", status: "success", sessionId: "session-drain", durationMs: 10 });
    secondClaude.emit("done", 0);
    await waitForAgentIdle(sessionId);

    const client2 = await TestClient.connect(port, sessionId);
    const queueUpdated = await drainUntil(client2, (m) => m.type === "queue_updated", 40, 3000);
    expect(queueUpdated).toMatchObject({ type: "queue_updated", queue: [] });

    client2.close();
  });

  it("cancel_queued_message with position removes a specific item", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "First" });
    const firstClaude = await waitForClaude(() => lastClaude);

    client.send({ type: "send_message", text: "Second" });
    client.send({ type: "send_message", text: "Third" });

    const queuedMsgs: AnyMsg[] = [];
    while (queuedMsgs.length < 2) {
      const msg: AnyMsg = await client.receive(2000);
      if (msg.type === "message_queued") queuedMsgs.push(msg);
    }
    expect(queuedMsgs).toHaveLength(2);

    client.send({ type: "cancel_queued_message", position: 0 });

    const update = await drainUntil(client, (m) => m.type === "queue_updated");
    expect(update).toMatchObject({
      type: "queue_updated",
      queue: [{ text: "Third", position: 1 }],
    });

    firstClaude.emit("event", { type: "agent_result", status: "success", sessionId: "s1", durationMs: 10 });
    firstClaude.emit("done", 0);

    const secondClaude = await waitForClaude(() => lastClaude, firstClaude);
    expect(secondClaude.lastPrompt).toBe("Third");

    client.close();
  });

  it("cancel_queued_message with 'all' clears the entire queue", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "First" });
    const firstClaude = await waitForClaude(() => lastClaude);

    client.send({ type: "send_message", text: "Second" });
    client.send({ type: "send_message", text: "Third" });

    const queuedMsgs: AnyMsg[] = [];
    while (queuedMsgs.length < 2) {
      const msg: AnyMsg = await client.receive(2000);
      if (msg.type === "message_queued") queuedMsgs.push(msg);
    }

    client.send({ type: "cancel_queued_message", position: "all" });

    const update = await drainUntil(client, (m) => m.type === "queue_updated");
    expect(update).toMatchObject({ type: "queue_updated", queue: [] });

    const savedLastClaude = lastClaude;
    firstClaude.emit("event", { type: "agent_result", status: "success", sessionId: "s1", durationMs: 10 });
    firstClaude.emit("done", 0);

    await new Promise((r) => setTimeout(r, 100));
    expect(lastClaude).toBe(savedLastClaude);

    client.close();
  });

  it("error path: rejects invalid images immediately without queuing", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({
      type: "send_message",
      text: "Hello",
      images: [{ data: "not-valid-base64!!!", mediaType: "image/png" }],
    });

    const errorMsg = await drainUntil(client, (m) => m.type === "error");
    expect(errorMsg?.type).toBe("error");

    client.close();
  });

  it("queuing still works after a Claude error (done with non-zero code)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "First" });
    const firstClaude = await waitForClaude(() => lastClaude);

    client.send({ type: "send_message", text: "Second after error" });

    const queued = await drainUntil(client, (m) => m.type === "message_queued");
    expect(queued?.type).toBe("message_queued");

    firstClaude.emit("done", 1);

    const secondClaude = await waitForClaude(() => lastClaude, firstClaude);
    expect(secondClaude.lastPrompt).toBe("Second after error");

    client.close();
  });

  it("drains the remaining queue when a queued message's agent emits error", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "First" });
    const firstClaude = await waitForClaude(() => lastClaude);
    firstClaude.emit("event", { type: "agent_init", sessionId: "s-1", model: "claude-sonnet-4-6", tools: [] });

    client.send({ type: "send_message", text: "Second" });
    client.send({ type: "send_message", text: "Third" });

    const queuedMsgs: AnyMsg[] = [];
    while (queuedMsgs.length < 2) {
      const msg: AnyMsg = await client.receive(2000);
      if (msg.type === "message_queued") queuedMsgs.push(msg);
    }
    expect(queuedMsgs).toHaveLength(2);

    firstClaude.emit("event", { type: "agent_result", status: "success", sessionId: "s-1", durationMs: 10 });
    firstClaude.emit("done", 0);

    const secondClaude = await waitForClaude(() => lastClaude, firstClaude);
    expect(secondClaude.lastPrompt).toBe("Second");

    secondClaude.emit("error", new Error("Agent already running"));

    const thirdClaude = await waitForClaude(() => lastClaude, secondClaude);
    expect(thirdClaude.lastPrompt).toBe("Third");

    client.close();
  });

  it("drains the queue on agent_result even when no agent_done arrives (SSE-drop resilience)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "First" });
    const firstClaude = await waitForClaude(() => lastClaude);
    firstClaude.emit("event", { type: "agent_init", sessionId: "s-result-only", model: "claude-sonnet-4-6", tools: [] });

    client.send({ type: "send_message", text: "Second" });
    const queued = await drainUntil(client, (m) => m.type === "message_queued");
    expect(queued?.type).toBe("message_queued");

    firstClaude.emit("event", { type: "agent_result", status: "success", sessionId: "s-result-only", durationMs: 100 });

    const secondClaude = await waitForClaude(() => lastClaude, firstClaude);
    expect(secondClaude.lastPrompt).toBe("Second");

    client.close();
  });

  it("syncs OAuth token back on agent_result even when no agent_done arrives (SSE-drop resilience)", async () => {
    finalizeAgentEnvSpy.mockClear();
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Only message" });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "agent_init", sessionId: "s-token-sync", model: "claude-sonnet-4-6", tools: [] });

    claude.emit("event", { type: "agent_result", status: "success", sessionId: "s-token-sync", durationMs: 100 });

    await new Promise((r) => setTimeout(r, 50));

    // This in-process runner tests invocation; it does not copy credential files.
    expect(finalizeAgentEnvSpy).toHaveBeenCalledTimes(1);

    claude.emit("done", 0);
    await new Promise((r) => setTimeout(r, 50));
    expect(finalizeAgentEnvSpy).toHaveBeenCalledTimes(1);

    client.close();
  });
});
