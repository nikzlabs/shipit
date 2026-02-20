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

    // Connect a new client and request chat history (which triggers activateSession)
    const client2 = await TestClient.connect(port);
    await client2.receive(); // preview_status

    client2.send({ type: "get_chat_history", sessionId });

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

    client2.send({ type: "get_chat_history", sessionId });

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

    // Ask for status
    client.send({ type: "get_session_status", sessionId } as any);
    const status = await drainUntil(client, (m) => m.type === "session_status" && m.sessionId === sessionId);
    expect(status).toBeTruthy();
    expect(status!.running).toBe(true);

    // Finish Claude
    claude.finish("test-session-id");

    // Wait for finish broadcast
    await drainUntil(client, (m) => m.type === "session_agent_finished");

    // Ask again — should be not running
    client.send({ type: "get_session_status", sessionId } as any);
    const status2 = await drainUntil(client, (m) => m.type === "session_status" && m.sessionId === sessionId);
    expect(status2).toBeTruthy();
    expect(status2!.running).toBe(false);

    client.close();
  });

  it("get_session_status returns not running for unknown sessions", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "get_session_status", sessionId: "nonexistent" } as any);
    const status = await drainUntil(client, (m) => m.type === "session_status");
    expect(status).toBeTruthy();
    expect(status!.running).toBe(false);
    expect(status!.queueLength).toBe(0);

    client.close();
  });
});
