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
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../auth.js";
import { PreviewManager } from "../preview-manager.js";
import { FileWatcher } from "../file-watcher.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubPreviewManager,
  StubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
  waitForClaude,
  createTestCredentialStore,
} from "./test-helpers.js";

type AnyMsg = any;

describe("Integration: persistent session runners", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let lastClaude: FakeClaudeProcess = null as any;

  beforeEach(async () => {
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-persistent-"));

    sessionManager = new SessionManager(path.join(tmpDir, "sessions.json"));
    chatHistoryManager = new ChatHistoryManager(path.join(tmpDir, "chat-history"));

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager,
      previewManager: new StubPreviewManager() as unknown as PreviewManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      claudeFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as any;
      },
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      workspaceDir: tmpDir,
      serveStatic: false,
      startPreview: false,
      portScanIntervalMs: 0,
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

  /** Drain messages until predicate returns truthy. */
  async function drainUntil(client: TestClient, predicate: (m: AnyMsg) => boolean, maxMsgs = 30): Promise<AnyMsg | null> {
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

    // Start Claude
    client1.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);

    // Emit init event to trigger session_started
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-session-1" });

    // Get the session ID from session_started
    const sessionStarted = await drainUntil(client1, (m) => m.type === "session_started");
    expect(sessionStarted).toBeTruthy();
    const sessionId = sessionStarted!.session.id;

    // Disconnect
    client1.close();
    await new Promise((r) => setTimeout(r, 50));

    // Connect a new client and activate the session (triggers activateSession)
    const client2 = await TestClient.connect(port);
    await client2.receive(); // preview_status

    client2.send({ type: "activate_session", sessionId });

    // Should receive session_status showing running=true
    const statusMsg = await drainUntil(client2, (m) => m.type === "session_status");
    expect(statusMsg).toBeTruthy();
    expect(statusMsg!.sessionId).toBe(sessionId);
    expect(statusMsg!.running).toBe(true);

    // Finish the agent
    claude.finish("test-session-id");
    client2.close();
  });

  it("session_agent_started and session_agent_finished are broadcast", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive(); // preview_status

    const client2 = await TestClient.connect(port);
    await client2.receive(); // preview_status

    // Client1 starts Claude
    client1.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);

    // Client2 should receive session_agent_started (broadcast)
    const started = await drainUntil(client2, (m) => m.type === "session_agent_started");
    expect(started).toBeTruthy();

    // Finish Claude
    claude.finish("test-session-id");

    // Client2 should receive session_agent_finished
    const finished = await drainUntil(client2, (m) => m.type === "session_agent_finished");
    expect(finished).toBeTruthy();

    client1.close();
    client2.close();
  });

  it("reconnecting replays buffered turn events", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive(); // preview_status

    // Start Claude
    client1.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);

    // Emit init event to trigger session_started
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-session-2" });

    // Get session ID
    const sessionStarted = await drainUntil(client1, (m) => m.type === "session_started");
    const sessionId = sessionStarted!.session.id;

    // Emit assistant event in Claude format (FakeClaudeProcess is wrapped by ClaudeAdapter)
    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Here is the answer" }] },
    });

    // Wait for client1 to receive the events
    const assistantMsg = await drainUntil(client1, (m) => m.type === "claude_event" && m.event?.type === "assistant");
    expect(assistantMsg).toBeTruthy();

    // Disconnect client1
    client1.close();
    await new Promise((r) => setTimeout(r, 50));

    // Reconnect as client2 and activate the same session
    const client2 = await TestClient.connect(port);
    await client2.receive(); // preview_status

    client2.send({ type: "activate_session", sessionId });

    // Client2 should receive replayed events from the turn buffer
    // The buffer includes agent_event and claude_event from the assistant message
    const replayed = await drainUntil(client2, (m) =>
      m.type === "claude_event" && m.event?.type === "assistant"
    );
    expect(replayed).toBeTruthy();

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

    // Wait for finish broadcast
    await drainUntil(client, (m) => m.type === "session_agent_finished");

    // Ask again — should be not running
    const statusRes2 = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/status` });
    expect(statusRes2.statusCode).toBe(200);
    expect(statusRes2.json().running).toBe(false);

    client.close();
  });

  it("session switch does not kill previous session's agent", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Start Claude in session 1
    client.send({ type: "send_message", text: "Hello" });
    const claude1 = await waitForClaude(() => lastClaude);

    // Emit init event to get session ID
    claude1.emit("event", { type: "system", subtype: "init", session_id: "agent-session-s1" });
    await drainUntil(client, (m) => m.type === "session_started");

    // Create a second session manually
    const session2Id = "session-2-" + Date.now();
    const session2Dir = path.join(tmpDir, "sessions", session2Id);
    fs.mkdirSync(session2Dir, { recursive: true });
    sessionManager.track(session2Id, "Session 2", session2Dir);

    // Switch to session 2 via activate_session
    client.send({ type: "activate_session", sessionId: session2Id });
    await new Promise((r) => setTimeout(r, 100)); // Wait for activation

    // Claude in session 1 should still be alive
    expect(claude1.killed).toBe(false);
    expect(claude1.interrupted).toBe(false);

    // Finish session 1's agent
    claude1.finish("test-session-id");
    client.close();
  });

  it("interrupt works via runner", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Start Claude
    client.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);

    // Interrupt
    client.send({ type: "interrupt_claude" } as any);

    // Should receive claude_interrupted
    const interrupted = await drainUntil(client, (m) => m.type === "claude_interrupted");
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

    // Start Claude
    client1.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);

    // Emit init event to get session ID
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-session-q" });
    const sessionStarted = await drainUntil(client1, (m) => m.type === "session_started");
    const sessionId = sessionStarted!.session.id;

    // Send another message while agent is running — should be queued
    client1.send({ type: "send_message", text: "Second message" });
    const queued = await drainUntil(client1, (m) => m.type === "message_queued");
    expect(queued).toBeTruthy();

    // Disconnect
    client1.close();
    await new Promise((r) => setTimeout(r, 50));

    // Reconnect
    const client2 = await TestClient.connect(port);
    await client2.receive(); // preview_status

    // Activate the same session
    client2.send({ type: "activate_session", sessionId });

    // Should receive queue_updated showing the queued message
    const queueMsg = await drainUntil(client2, (m) => m.type === "queue_updated");
    expect(queueMsg).toBeTruthy();
    expect(queueMsg!.queue.length).toBeGreaterThanOrEqual(1);

    // Finish Claude
    claude.finish("test-session-id");
    client2.close();
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
    const session2Id = "concurrent-session-2-" + Date.now();
    const session2Dir = path.join(tmpDir, "sessions", session2Id);
    fs.mkdirSync(session2Dir, { recursive: true });
    sessionManager.track(session2Id, "Session 2", session2Dir);

    // Client 2 connects and switches to session 2
    const client2 = await TestClient.connect(port);
    await client2.receive(); // preview_status

    client2.send({ type: "activate_session", sessionId: session2Id });
    await new Promise((r) => setTimeout(r, 100)); // Wait for activation

    // Client 2 starts a second agent in session 2 (must specify sessionId)
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
    await drainUntil(client1, (m) => m.type === "session_agent_finished");

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
