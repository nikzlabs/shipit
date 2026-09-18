import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

describe("Integration: persistent session runners", () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-persistent-"));

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

  async function drainUntil(client: TestClient, predicate: (m: AnyMsg) => boolean, maxMsgs = 30): Promise<AnyMsg> {
    for (let i = 0; i < maxMsgs; i++) {
      const msg: AnyMsg = await client.receive(3000);
      if (predicate(msg)) return msg;
    }
    return null;
  }

  it("agent keeps running after client disconnects", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);
    expect(claude.runCalled).toBe(true);

    client.close();
    await new Promise((r) => setTimeout(r, 100));

    expect(claude.killed).toBe(false);
    expect(claude.interrupted).toBe(false);
  });

  it("reconnecting to a session with a running agent sends session_status", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive();
    const sessionId = client1.sessionId;

    client1.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);

    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-session-1" });

    await drainUntil(client1, (m) => m.type === "session_started");

    client1.close();
    await new Promise((r) => setTimeout(r, 50));

    const client2 = await TestClient.connect(port, sessionId);

    const statusMsg = await drainUntil(client2, (m) => m.type === "session_status");
    expect(statusMsg).toBeTruthy();
    expect(statusMsg!.sessionId).toBe(sessionId);
    expect(statusMsg!.running).toBe(true);

    claude.finish("test-session-id");
    client2.close();
  });

  it("reconnecting to same session sees running status", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive();
    const sessionId = client1.sessionId;

    client1.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-bc" });
    await drainUntil(client1, (m) => m.type === "session_started");

    const client2 = await TestClient.connect(port, sessionId);
    const statusMsg = await drainUntil(client2, (m) => m.type === "session_status");
    expect(statusMsg).toBeTruthy();
    expect(statusMsg!.running).toBe(true);

    claude.finish("test-session-id");

    const finished = await drainUntil(client2, (m) =>
      m.type === "log_append" && m.channel === "agent" &&
      m.records?.some((r: { text?: string }) => r.text?.includes("exited")),
    );
    expect(finished).toBeTruthy();

    client1.close();
    client2.close();
  });

  it("reconnecting to a running session shows running status and history is available via HTTP", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive();
    const sessionId = client1.sessionId;

    client1.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);

    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-session-2" });
    await drainUntil(client1, (m) => m.type === "session_started");

    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Here is the answer" }] },
    });
    await drainUntil(client1, (m) => m.type === "agent_event" && m.event?.type === "agent_assistant");
    claude.emit("event", {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] },
    });
    await drainUntil(client1, (m) => m.type === "agent_event" && m.event?.type === "agent_tool_result");

    client1.close();
    await new Promise((r) => setTimeout(r, 50));

    const client2 = await TestClient.connect(port, sessionId);
    const statusMsg = await drainUntil(client2, (m) => m.type === "session_status");
    expect(statusMsg).toBeTruthy();
    expect(statusMsg!.running).toBe(true);

    const historyRes = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    const history = historyRes.json();
    expect(history.agentRunning).toBe(true);
    const assistantMsgs = history.messages.filter((m: AnyMsg) => m.role === "assistant");
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
    expect(assistantMsgs[0].text).toContain("Here is the answer");

    claude.finish("test-session-id");
    client2.close();
  });

  it("get_session_status returns running state for known sessions", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);

    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-session-3" });

    const sessionStarted = await drainUntil(client, (m) => m.type === "session_started");
    const sessionId = sessionStarted!.session.id;

    const statusRes = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/status` });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json().running).toBe(true);

    claude.finish("test-session-id");

    try { for (let i = 0; i < 20; i++) await client.receive(300); } catch { /* timeout expected */ }

    const statusRes2 = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/status` });
    expect(statusRes2.statusCode).toBe(200);
    expect(statusRes2.json().running).toBe(false);

    client.close();
  });

  it("disconnecting from session does not kill its agent", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Hello" });
    const claude1 = await waitForClaude(() => lastClaude);

    claude1.emit("event", { type: "system", subtype: "init", session_id: "agent-session-s1" });
    await drainUntil(client, (m) => m.type === "session_started");

    client.close();
    await new Promise((r) => setTimeout(r, 100));

    expect(claude1.killed).toBe(false);
    expect(claude1.interrupted).toBe(false);

    claude1.finish("test-session-id");
  });

  it("interrupt works via runner", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);

    client.send({ type: "interrupt_agent" } as any);

    const interrupted = await drainUntil(client, (m) => m.type === "agent_interrupted");
    expect(interrupted).toBeTruthy();

    claude.finish("test-session-id");
    client.close();
  });

  it("archive kills runner", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);

    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-session-arch" });
    const sessionStarted = await drainUntil(client, (m) => m.type === "session_started");
    const sessionId = sessionStarted!.session.id;

    const res = await app.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` });
    expect(res.statusCode).toBe(200);

    expect(claude.killed).toBe(true);

    client.close();
  });

  it("queue persists across connection drops", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive();
    const sessionId = client1.sessionId;

    client1.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);

    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-session-q" });
    await drainUntil(client1, (m) => m.type === "session_started");

    client1.send({ type: "send_message", text: "Second message" });
    const queued = await drainUntil(client1, (m) => m.type === "message_queued");
    expect(queued).toBeTruthy();

    client1.close();
    await new Promise((r) => setTimeout(r, 50));

    const client2 = await TestClient.connect(port, sessionId);

    const queueMsg = await drainUntil(client2, (m) => m.type === "queue_updated");
    expect(queueMsg).toBeTruthy();
    expect(queueMsg!.queue.length).toBeGreaterThanOrEqual(1);

    claude.finish("test-session-id");
    client2.close();
  });

  it("agent turn completes correctly after viewer disconnects mid-turn", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive();
    const sessionId = client1.sessionId;

    client1.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);

    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-disconnect-1" });
    await drainUntil(client1, (m) => m.type === "session_started");

    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Here is my answer" }] },
    });
    await drainUntil(client1, (m) => m.type === "agent_event" && m.event?.type === "agent_assistant");

    claude.emit("event", {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] },
    });
    await drainUntil(client1, (m) => m.type === "agent_event" && m.event?.type === "agent_tool_result");

    client1.close();
    await new Promise((r) => setTimeout(r, 100));

    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: " and more details" }] },
    });
    await new Promise((r) => setTimeout(r, 50));

    claude.finish("agent-disconnect-1");
    await new Promise((r) => setTimeout(r, 200));

    const statusRes = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/status` });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json().running).toBe(false);

    const historyRes = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    expect(historyRes.statusCode).toBe(200);
    const history = historyRes.json();
    expect(history.agentRunning).toBe(false);

    const userMsgs = history.messages.filter((m: AnyMsg) => m.role === "user");
    const assistantMsgs = history.messages.filter((m: AnyMsg) => m.role === "assistant");
    expect(userMsgs.length).toBeGreaterThanOrEqual(1);
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);

    const allText = assistantMsgs.map((m: AnyMsg) => m.text).join("");
    expect(allText).toContain("Here is my answer");
    expect(allText).toContain("and more details");

    for (const m of history.messages) {
      expect(m.inProgress).toBeFalsy();
    }
  });

  it("get_session_status returns 404 for unknown sessions", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/nonexistent/status" });
    expect(res.statusCode).toBe(404);
  });

  it("multiple concurrent agents run across different sessions", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive();

    client1.send({ type: "send_message", text: "Task for session 1" });
    const claude1 = await waitForClaude(() => lastClaude);

    claude1.emit("event", { type: "system", subtype: "init", session_id: "agent-session-c1" });
    const session1Started = await drainUntil(client1, (m) => m.type === "session_started");
    const session1Id = session1Started!.session.id;

    const session2Id = `concurrent-session-2-${  Date.now()}`;
    const session2Dir = path.join(tmpDir, "sessions", session2Id);
    fs.mkdirSync(session2Dir, { recursive: true });
    sessionManager.track(session2Id, "Session 2", session2Dir);

    const client2 = await TestClient.connect(port, session2Id);
    await client2.receive();

    const prevClaude = lastClaude;
    client2.send({ type: "send_message", text: "Task for session 2", sessionId: session2Id });
    const claude2 = await waitForClaude(() => lastClaude, prevClaude);

    claude2.emit("event", { type: "system", subtype: "init", session_id: "agent-session-c2" });

    expect(claude1.killed).toBe(false);
    expect(claude1.interrupted).toBe(false);
    expect(claude2.killed).toBe(false);
    expect(claude2.interrupted).toBe(false);
    expect(claude1).not.toBe(claude2);

    const statusRes1 = await app.inject({ method: "GET", url: `/api/sessions/${session1Id}/status` });
    expect(statusRes1.json().running).toBe(true);

    const statusRes2 = await app.inject({ method: "GET", url: `/api/sessions/${session2Id}/status` });
    expect(statusRes2.json().running).toBe(true);

    claude1.finish("test-session-1");
    try { for (let i = 0; i < 20; i++) await client1.receive(300); } catch { /* timeout expected */ }

    expect(claude2.killed).toBe(false);
    expect(claude2.interrupted).toBe(false);

    const statusRes1After = await app.inject({ method: "GET", url: `/api/sessions/${session1Id}/status` });
    expect(statusRes1After.json().running).toBe(false);

    const statusRes2After = await app.inject({ method: "GET", url: `/api/sessions/${session2Id}/status` });
    expect(statusRes2After.json().running).toBe(true);

    claude2.finish("test-session-2");
    client1.close();
    client2.close();
  });
});
