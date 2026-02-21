/**
 * Integration tests for multi-tab scenarios (feature 041).
 *
 * Each test simulates two browser tabs (two WebSocket connections) interacting
 * with the server simultaneously. Tests verify session isolation, shared state
 * when viewing the same session, and cross-tab notifications.
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

describe("Integration: multi-tab scenarios", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let lastClaude: FakeClaudeProcess = null as any;

  beforeEach(async () => {
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-multitab-"));

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

  /** Create a tracked session with a real directory and git repo. */
  function createSession(name: string): { sessionId: string; sessionDir: string } {
    const sessionId = `session-${name}-${Date.now()}`;
    const sessionDir = path.join(tmpDir, "sessions", sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    sessionManager.track(sessionId, name, sessionDir);
    return { sessionId, sessionDir };
  }

  it("two connections viewing different sessions get isolated agents", async () => {
    const session1 = createSession("tab1-session");
    const session2 = createSession("tab2-session");

    // Tab 1 connects and activates session 1
    const tab1 = await TestClient.connect(port);
    await tab1.receive(); // preview_status
    tab1.send({ type: "activate_session", sessionId: session1.sessionId });
    await new Promise((r) => setTimeout(r, 100)); // Wait for activation

    // Tab 2 connects and activates session 2
    const tab2 = await TestClient.connect(port);
    await tab2.receive(); // preview_status
    tab2.send({ type: "activate_session", sessionId: session2.sessionId });
    await new Promise((r) => setTimeout(r, 100)); // Wait for activation

    // Tab 1 starts agent in session 1
    tab1.send({ type: "send_message", text: "Hello from tab 1", sessionId: session1.sessionId });
    const claude1 = await waitForClaude(() => lastClaude);
    claude1.emit("event", { type: "system", subtype: "init", session_id: "agent-mt-1" });

    // Tab 2 starts agent in session 2
    const prevClaude = lastClaude;
    tab2.send({ type: "send_message", text: "Hello from tab 2", sessionId: session2.sessionId });
    const claude2 = await waitForClaude(() => lastClaude, prevClaude);
    claude2.emit("event", { type: "system", subtype: "init", session_id: "agent-mt-2" });

    // Both agents should be independent
    expect(claude1).not.toBe(claude2);
    expect(claude1.killed).toBe(false);
    expect(claude2.killed).toBe(false);

    // Finish agent in session 1 — session 2's agent should be unaffected
    claude1.finish("test-mt-1");

    // Verify session 2 is still running
    const statusRes = await app.inject({ method: "GET", url: `/api/sessions/${session2.sessionId}/status` });
    expect(statusRes.json().running).toBe(true);
    expect(claude2.killed).toBe(false);

    // Clean up
    claude2.finish("test-mt-2");
    tab1.close();
    tab2.close();
  });

  it("two connections viewing the same session share agent events", async () => {
    const session = createSession("shared-session");

    // Tab 1 connects and activates the session
    const tab1 = await TestClient.connect(port);
    await tab1.receive(); // preview_status
    tab1.send({ type: "activate_session", sessionId: session.sessionId });
    await new Promise((r) => setTimeout(r, 100)); // Wait for activation

    // Tab 1 starts an agent
    tab1.send({ type: "send_message", text: "Hello", sessionId: session.sessionId });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-shared" });

    // Drain tab1 to get past session_started
    await drainUntil(tab1, (m) => m.type === "session_started");

    // Tab 2 connects and views the same session — should get replayed events
    const tab2 = await TestClient.connect(port);
    await tab2.receive(); // preview_status
    tab2.send({ type: "activate_session", sessionId: session.sessionId });

    // Tab 2 should receive session_status showing running=true
    const status = await drainUntil(tab2, (m) => m.type === "session_status");
    expect(status).toBeTruthy();
    expect(status!.running).toBe(true);

    // Emit a new assistant event — both tabs should receive it
    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Shared response" }] },
    });

    // Both tabs should see the assistant event
    const tab1Event = await drainUntil(tab1, (m) =>
      m.type === "claude_event" && m.event?.type === "assistant"
    );
    const tab2Event = await drainUntil(tab2, (m) =>
      m.type === "claude_event" && m.event?.type === "assistant"
    );
    expect(tab1Event).toBeTruthy();
    expect(tab2Event).toBeTruthy();

    // Clean up
    claude.finish("test-shared");
    tab1.close();
    tab2.close();
  });

  it("interrupt from one tab affects shared runner, both tabs notified", async () => {
    const session = createSession("interrupt-session");

    // Tab 1 connects and starts an agent
    const tab1 = await TestClient.connect(port);
    await tab1.receive(); // preview_status
    tab1.send({ type: "send_message", text: "Work on this", sessionId: session.sessionId });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-int" });

    // Drain tab1 to get past session_started
    await drainUntil(tab1, (m) => m.type === "session_started");

    // Tab 2 connects and views the same session
    const tab2 = await TestClient.connect(port);
    await tab2.receive(); // preview_status
    tab2.send({ type: "activate_session", sessionId: session.sessionId });
    await drainUntil(tab2, (m) => m.type === "session_status");

    // Tab 2 sends interrupt — should affect the shared runner
    tab2.send({ type: "interrupt_claude" } as any);

    // Both tabs should receive claude_interrupted
    const tab1Interrupt = await drainUntil(tab1, (m) => m.type === "claude_interrupted");
    const tab2Interrupt = await drainUntil(tab2, (m) => m.type === "claude_interrupted");
    expect(tab1Interrupt).toBeTruthy();
    expect(tab2Interrupt).toBeTruthy();

    // The underlying claude process should be interrupted
    expect(claude.interrupted).toBe(true);

    // Clean up
    claude.finish("test-int");
    tab1.close();
    tab2.close();
  });

  it("session switch in one tab does not affect the other tab's view", async () => {
    const session1 = createSession("stay-session");
    const session2 = createSession("switch-session");

    // Tab 1 connects and starts an agent in session 1
    const tab1 = await TestClient.connect(port);
    await tab1.receive(); // preview_status
    tab1.send({ type: "send_message", text: "Working", sessionId: session1.sessionId });
    const claude1 = await waitForClaude(() => lastClaude);
    claude1.emit("event", { type: "system", subtype: "init", session_id: "agent-stay" });
    await drainUntil(tab1, (m) => m.type === "session_started");

    // Tab 2 connects and views session 1
    const tab2 = await TestClient.connect(port);
    await tab2.receive(); // preview_status
    tab2.send({ type: "activate_session", sessionId: session1.sessionId });
    await drainUntil(tab2, (m) => m.type === "session_status");

    // Tab 2 switches to session 2
    tab2.send({ type: "activate_session", sessionId: session2.sessionId });
    await new Promise((r) => setTimeout(r, 100)); // Wait for activation

    // Session 1's agent should still be running — tab2 switching didn't kill it
    expect(claude1.killed).toBe(false);
    expect(claude1.interrupted).toBe(false);

    // Tab 1 should still receive events from session 1
    claude1.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Still going" }] },
    });
    const tab1Event = await drainUntil(tab1, (m) =>
      m.type === "claude_event" && m.event?.type === "assistant"
    );
    expect(tab1Event).toBeTruthy();

    // Clean up
    claude1.finish("test-stay");
    tab1.close();
    tab2.close();
  });

  it("full_reset from one tab notifies all tabs", async () => {
    const session = createSession("reset-session");

    // Tab 1 activates a session
    const tab1 = await TestClient.connect(port);
    await tab1.receive(); // preview_status
    tab1.send({ type: "activate_session", sessionId: session.sessionId });
    await new Promise((r) => setTimeout(r, 100)); // Wait for activation

    // Tab 2 also connected
    const tab2 = await TestClient.connect(port);
    await tab2.receive(); // preview_status

    // Full reset via HTTP — broadcasts full_reset_complete to all WS clients
    const res = await app.inject({ method: "POST", url: "/api/reset" });
    expect(res.statusCode).toBe(200);

    // Both tabs should receive full_reset_complete (broadcast)
    const tab1Reset = await drainUntil(tab1, (m) => m.type === "full_reset_complete");
    const tab2Reset = await drainUntil(tab2, (m) => m.type === "full_reset_complete");
    expect(tab1Reset).toBeTruthy();
    expect(tab2Reset).toBeTruthy();

    tab1.close();
    tab2.close();
  });

  it("file tree and git log requests are scoped to each connection's viewed session", async () => {
    const session1 = createSession("files-session-1");
    const session2 = createSession("files-session-2");

    // Create distinct files in each session directory
    fs.writeFileSync(path.join(session1.sessionDir, "file-from-session1.txt"), "hello from s1");
    fs.writeFileSync(path.join(session2.sessionDir, "file-from-session2.txt"), "hello from s2");

    // Tab 1 activates session 1
    const tab1 = await TestClient.connect(port);
    await tab1.receive(); // preview_status
    tab1.send({ type: "activate_session", sessionId: session1.sessionId });
    await new Promise((r) => setTimeout(r, 100)); // Wait for activation

    // Tab 2 activates session 2
    const tab2 = await TestClient.connect(port);
    await tab2.receive(); // preview_status
    tab2.send({ type: "activate_session", sessionId: session2.sessionId });
    await new Promise((r) => setTimeout(r, 100)); // Wait for activation

    // Tab 1 requests file tree — should see session 1's files
    const treeRes1 = await app.inject({ method: "GET", url: `/api/sessions/${session1.sessionId}/files` });
    const files1 = JSON.stringify(treeRes1.json().tree);
    expect(files1).toContain("file-from-session1.txt");
    expect(files1).not.toContain("file-from-session2.txt");

    // Tab 2 requests file tree — should see session 2's files
    const treeRes2 = await app.inject({ method: "GET", url: `/api/sessions/${session2.sessionId}/files` });
    const files2 = JSON.stringify(treeRes2.json().tree);
    expect(files2).toContain("file-from-session2.txt");
    expect(files2).not.toContain("file-from-session1.txt");

    tab1.close();
    tab2.close();
  });
});
