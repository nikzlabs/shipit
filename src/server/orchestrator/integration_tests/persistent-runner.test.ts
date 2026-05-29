/**
 * Integration tests for persistent session runners (feature 041).
 *
 * When Claude is running and the WebSocket disconnects, the agent keeps
 * running. Reconnecting to the same session replays buffered turn events,
 * shows queue state, and lets the user continue interacting.
 */

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

  /** Drain messages until predicate returns truthy. */
  async function drainUntil(client: TestClient, predicate: (m: AnyMsg) => boolean, maxMsgs = 30): Promise<AnyMsg> {
    for (let i = 0; i < maxMsgs; i++) {
      const msg: AnyMsg = await client.receive(3000);
      if (predicate(msg)) return msg;
    }
    return null;
  }

  it("agent keeps running after client disconnects", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Start Claude
    client.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);
    expect(claude.runCalled).toBe(true);

    // Disconnect — agent should NOT be killed
    client.close();
    await new Promise((r) => setTimeout(r, 100));

    expect(claude.killed).toBe(false);
    expect(claude.interrupted).toBe(false);
  });

  it("reconnecting to a session with a running agent sends session_status", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive(); // preview_status
    const sessionId = client1.sessionId;

    // Start Claude
    client1.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);

    // Emit init event to trigger session_started
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-session-1" });

    // Drain session_started
    await drainUntil(client1, (m) => m.type === "session_started");

    // Disconnect
    client1.close();
    await new Promise((r) => setTimeout(r, 50));

    // Reconnect to the same session (auto-activates)
    const client2 = await TestClient.connect(port, sessionId);

    // Should receive session_status showing running=true
    const statusMsg = await drainUntil(client2, (m) => m.type === "session_status");
    expect(statusMsg).toBeTruthy();
    expect(statusMsg!.sessionId).toBe(sessionId);
    expect(statusMsg!.running).toBe(true);

    // Finish the agent
    claude.finish("test-session-id");
    client2.close();
  });

  it("reconnecting to same session sees running status", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive(); // preview_status
    const sessionId = client1.sessionId;

    // Client1 starts Claude
    client1.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-bc" });
    await drainUntil(client1, (m) => m.type === "session_started");

    // Client2 connects to the same session — sees running status
    const client2 = await TestClient.connect(port, sessionId);
    const statusMsg = await drainUntil(client2, (m) => m.type === "session_status");
    expect(statusMsg).toBeTruthy();
    expect(statusMsg!.running).toBe(true);

    // Finish Claude
    claude.finish("test-session-id");

    // Client2 should receive the exit log entry (session_agent_finished is SSE-only)
    const finished = await drainUntil(client2, (m) =>
      m.type === "log_entry" && (m).text?.includes("exited"),
    );
    expect(finished).toBeTruthy();

    client1.close();
    client2.close();
  });

  it("reconnecting to a running session shows running status and history is available via HTTP", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive(); // preview_status
    const sessionId = client1.sessionId;

    // Start Claude
    client1.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);

    // Emit init event to trigger session_started
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-session-2" });
    await drainUntil(client1, (m) => m.type === "session_started");

    // Emit assistant + tool_result to trigger incremental persistence
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

    // Disconnect client1
    client1.close();
    await new Promise((r) => setTimeout(r, 50));

    // Reconnect to the same session — should see running status
    const client2 = await TestClient.connect(port, sessionId);
    const statusMsg = await drainUntil(client2, (m) => m.type === "session_status");
    expect(statusMsg).toBeTruthy();
    expect(statusMsg!.running).toBe(true);

    // HTTP history should include the in-progress assistant message
    const historyRes = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    const history = historyRes.json();
    expect(history.agentRunning).toBe(true);
    const assistantMsgs = history.messages.filter((m: AnyMsg) => m.role === "assistant");
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
    expect(assistantMsgs[0].text).toContain("Here is the answer");

    // Finish Claude
    claude.finish("test-session-id");
    client2.close();
  });

  it("get_session_status returns running state for known sessions", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Start Claude
    client.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);

    // Emit init event to trigger session_started
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-session-3" });

    // Get session ID
    const sessionStarted = await drainUntil(client, (m) => m.type === "session_started");
    const sessionId = sessionStarted!.session.id;

    // Ask for status via HTTP
    const statusRes = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/status` });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json().running).toBe(true);

    // Finish Claude
    claude.finish("test-session-id");

    // Drain all remaining messages (exit log, git_committed, etc.)
    // then wait for async done handler to complete (setIsClaudeRunning)
    try { for (let i = 0; i < 20; i++) await client.receive(300); } catch { /* timeout expected */ }

    // Ask again — should be not running
    const statusRes2 = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/status` });
    expect(statusRes2.statusCode).toBe(200);
    expect(statusRes2.json().running).toBe(false);

    client.close();
  });

  it("disconnecting from session does not kill its agent", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Start Claude
    client.send({ type: "send_message", text: "Hello" });
    const claude1 = await waitForClaude(() => lastClaude);

    // Emit init event to get session ID
    claude1.emit("event", { type: "system", subtype: "init", session_id: "agent-session-s1" });
    await drainUntil(client, (m) => m.type === "session_started");

    // Disconnect (simulates navigating to another session)
    client.close();
    await new Promise((r) => setTimeout(r, 100));

    // Claude should still be alive (persistent runner)
    expect(claude1.killed).toBe(false);
    expect(claude1.interrupted).toBe(false);

    // Finish session 1's agent
    claude1.finish("test-session-id");
  });

  it("interrupt works via runner", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Start Claude
    client.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);

    // Interrupt
    client.send({ type: "interrupt_agent" } as any);

    // Should receive agent_interrupted
    const interrupted = await drainUntil(client, (m) => m.type === "agent_interrupted");
    expect(interrupted).toBeTruthy();

    // Finish Claude
    claude.finish("test-session-id");
    client.close();
  });

  it("archive kills runner", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Start Claude
    client.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);

    // Emit init event to get session ID
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-session-arch" });
    const sessionStarted = await drainUntil(client, (m) => m.type === "session_started");
    const sessionId = sessionStarted!.session.id;

    // Archive the session via HTTP
    const res = await app.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` });
    expect(res.statusCode).toBe(200);

    // Claude should be killed
    expect(claude.killed).toBe(true);

    client.close();
  });

  it("queue persists across connection drops", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive(); // preview_status
    const sessionId = client1.sessionId;

    // Start Claude
    client1.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);

    // Emit init event
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-session-q" });
    await drainUntil(client1, (m) => m.type === "session_started");

    // Send another message while agent is running — should be queued
    client1.send({ type: "send_message", text: "Second message" });
    const queued = await drainUntil(client1, (m) => m.type === "message_queued");
    expect(queued).toBeTruthy();

    // Disconnect
    client1.close();
    await new Promise((r) => setTimeout(r, 50));

    // Reconnect to the same session (auto-activates, replays queue)
    const client2 = await TestClient.connect(port, sessionId);

    // Should receive queue_updated showing the queued message
    const queueMsg = await drainUntil(client2, (m) => m.type === "queue_updated");
    expect(queueMsg).toBeTruthy();
    expect(queueMsg!.queue.length).toBeGreaterThanOrEqual(1);

    // Finish Claude
    claude.finish("test-session-id");
    client2.close();
  });

  it("agent turn completes correctly after viewer disconnects mid-turn", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive(); // preview_status
    const sessionId = client1.sessionId;

    // Start Claude
    client1.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);

    // Emit init event to establish the session
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-disconnect-1" });
    await drainUntil(client1, (m) => m.type === "session_started");

    // Emit assistant text
    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Here is my answer" }] },
    });
    await drainUntil(client1, (m) => m.type === "agent_event" && m.event?.type === "agent_assistant");

    // Emit tool_result to trigger incremental persistence
    claude.emit("event", {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] },
    });
    await drainUntil(client1, (m) => m.type === "agent_event" && m.event?.type === "agent_tool_result");

    // Disconnect the viewer — agent continues running
    client1.close();
    await new Promise((r) => setTimeout(r, 100));

    // Emit more assistant text while disconnected
    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: " and more details" }] },
    });
    await new Promise((r) => setTimeout(r, 50));

    // Finish the agent while disconnected
    claude.finish("agent-disconnect-1");
    await new Promise((r) => setTimeout(r, 200));

    // Verify: runner should report not running
    const statusRes = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/status` });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json().running).toBe(false);

    // Verify: HTTP history should contain the persisted assistant messages
    const historyRes = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    expect(historyRes.statusCode).toBe(200);
    const history = historyRes.json();
    expect(history.agentRunning).toBe(false);

    // Should have: user message + at least one assistant message
    const userMsgs = history.messages.filter((m: AnyMsg) => m.role === "user");
    const assistantMsgs = history.messages.filter((m: AnyMsg) => m.role === "assistant");
    expect(userMsgs.length).toBeGreaterThanOrEqual(1);
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);

    // Assistant messages should contain text from both assistant events
    const allText = assistantMsgs.map((m: AnyMsg) => m.text).join("");
    expect(allText).toContain("Here is my answer");
    expect(allText).toContain("and more details");

    // No messages should have inProgress flag
    for (const m of history.messages) {
      expect(m.inProgress).toBeFalsy();
    }
  });

  it("get_session_status returns 404 for unknown sessions", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/nonexistent/status" });
    expect(res.statusCode).toBe(404);
  });

  it("multiple concurrent agents run across different sessions", async () => {
    // Client 1 starts an agent in session 1
    const client1 = await TestClient.connect(port);
    await client1.receive(); // preview_status

    client1.send({ type: "send_message", text: "Task for session 1" });
    const claude1 = await waitForClaude(() => lastClaude);

    claude1.emit("event", { type: "system", subtype: "init", session_id: "agent-session-c1" });
    const session1Started = await drainUntil(client1, (m) => m.type === "session_started");
    const session1Id = session1Started!.session.id;

    // Create a second session manually
    const session2Id = `concurrent-session-2-${  Date.now()}`;
    const session2Dir = path.join(tmpDir, "sessions", session2Id);
    fs.mkdirSync(session2Dir, { recursive: true });
    sessionManager.track(session2Id, "Session 2", session2Dir);

    // Client 2 connects directly to session 2
    const client2 = await TestClient.connect(port, session2Id);
    await client2.receive(); // preview_status

    // Client 2 starts a second agent in session 2
    const prevClaude = lastClaude;
    client2.send({ type: "send_message", text: "Task for session 2", sessionId: session2Id });
    const claude2 = await waitForClaude(() => lastClaude, prevClaude);

    claude2.emit("event", { type: "system", subtype: "init", session_id: "agent-session-c2" });

    // Both agents should be running simultaneously
    expect(claude1.killed).toBe(false);
    expect(claude1.interrupted).toBe(false);
    expect(claude2.killed).toBe(false);
    expect(claude2.interrupted).toBe(false);
    expect(claude1).not.toBe(claude2);

    // Verify both sessions report running
    const statusRes1 = await app.inject({ method: "GET", url: `/api/sessions/${session1Id}/status` });
    expect(statusRes1.json().running).toBe(true);

    const statusRes2 = await app.inject({ method: "GET", url: `/api/sessions/${session2Id}/status` });
    expect(statusRes2.json().running).toBe(true);

    // Finish session 1 — session 2 should still be running
    claude1.finish("test-session-1");
    // Drain all remaining messages and wait for async done handler to complete
    try { for (let i = 0; i < 20; i++) await client1.receive(300); } catch { /* timeout expected */ }

    expect(claude2.killed).toBe(false);
    expect(claude2.interrupted).toBe(false);

    // Verify session 1 stopped and session 2 still running
    const statusRes1After = await app.inject({ method: "GET", url: `/api/sessions/${session1Id}/status` });
    expect(statusRes1After.json().running).toBe(false);

    const statusRes2After = await app.inject({ method: "GET", url: `/api/sessions/${session2Id}/status` });
    expect(statusRes2After.json().running).toBe(true);

    // Clean up
    claude2.finish("test-session-2");
    client1.close();
    client2.close();
  });
});
