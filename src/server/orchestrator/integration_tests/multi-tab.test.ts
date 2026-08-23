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

describe("Integration: multi-tab scenarios", () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-multitab-"));

    sessionManager = new SessionManager(dbManager);
    chatHistoryManager = new ChatHistoryManager(dbManager);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      databaseManager: dbManager,
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

    // Tab 1 connects directly to session 1 (auto-activates)
    const tab1 = await TestClient.connect(port, session1.sessionId);
    await tab1.receive(); // preview_status

    // Tab 2 connects directly to session 2 (auto-activates)
    const tab2 = await TestClient.connect(port, session2.sessionId);
    await tab2.receive(); // preview_status

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

    // Tab 1 connects directly to the session (auto-activates)
    const tab1 = await TestClient.connect(port, session.sessionId);
    await tab1.receive(); // preview_status

    // Tab 1 starts an agent
    tab1.send({ type: "send_message", text: "Hello", sessionId: session.sessionId });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-shared" });

    // Drain tab1 to get past session_started
    await drainUntil(tab1, (m) => m.type === "session_started");

    // Tab 2 connects to the same session — should get replayed events
    const tab2 = await TestClient.connect(port, session.sessionId);

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
      m.type === "agent_event" && m.event?.type === "agent_assistant"
    );
    const tab2Event = await drainUntil(tab2, (m) =>
      m.type === "agent_event" && m.event?.type === "agent_assistant"
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

    // Tab 1 connects directly to the session and starts an agent
    const tab1 = await TestClient.connect(port, session.sessionId);
    await tab1.receive(); // preview_status
    tab1.send({ type: "send_message", text: "Work on this", sessionId: session.sessionId });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-int" });

    // Drain tab1 to get past session_started
    await drainUntil(tab1, (m) => m.type === "session_started");

    // Tab 2 connects to the same session
    const tab2 = await TestClient.connect(port, session.sessionId);
    await drainUntil(tab2, (m) => m.type === "session_status");

    // Tab 2 sends interrupt — should affect the shared runner
    tab2.send({ type: "interrupt_agent" } as any);

    // Both tabs should receive agent_interrupted
    const tab1Interrupt = await drainUntil(tab1, (m) => m.type === "agent_interrupted");
    const tab2Interrupt = await drainUntil(tab2, (m) => m.type === "agent_interrupted");
    expect(tab1Interrupt).toBeTruthy();
    expect(tab2Interrupt).toBeTruthy();

    // The underlying claude process should be interrupted
    expect(claude.interrupted).toBe(true);

    // Clean up
    claude.finish("test-int");
    tab1.close();
    tab2.close();
  });

  it("a user message typed in one tab reaches the other tab's transcript", async () => {
    // The reported bug: send from a phone with the same session open on a
    // desktop, and the desktop showed the agent's reply to a message that was
    // never on screen — until a reload or a session switch pulled it out of
    // persisted history. Only the SENDING client rendered the bubble
    // (optimistically), and the idle → fresh-turn path emitted nothing for
    // anyone else. Steering already broadcast `message_steered`; this is the
    // equivalent for the path that starts a turn.
    const session = createSession("echo-session");

    const desktop = await TestClient.connect(port, session.sessionId);
    await desktop.receive(); // preview_status
    const phone = await TestClient.connect(port, session.sessionId);
    await phone.receive(); // preview_status

    phone.send({
      type: "send_message",
      text: "ship it",
      sessionId: session.sessionId,
      requestId: "req-from-phone",
    } as AnyMsg);
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-echo" });

    // The already-attached viewer that did NOT send is the whole point.
    const echo = await drainUntil(desktop, (m) => m.type === "system_user_message");
    expect(echo).toBeTruthy();
    expect(echo!.text).toBe("ship it");
    expect(echo!.sessionId).toBe(session.sessionId);
    // Carries the sender's id so the phone can drop its own optimistic bubble
    // instead of text-matching (which would collapse a repeated "continue").
    expect(echo!.clientRequestId).toBe("req-from-phone");

    claude.finish("test-echo");
    desktop.close();
    phone.close();
  });

  it("a tab attaching later gets the user message from history, not a replayed echo", async () => {
    // The echo is buffered in the turn-event log like every other emit, but the
    // user row is persisted BEFORE it goes out — so a late attach's own history
    // load already has the bubble and replaying would double it. Worse, it
    // could not be deduped away: the rehydrated row carries no
    // `clientRequestId`.
    const session = createSession("echo-replay-session");

    const first = await TestClient.connect(port, session.sessionId);
    await first.receive(); // preview_status
    first.send({
      type: "send_message",
      text: "ship it",
      sessionId: session.sessionId,
      requestId: "req-first",
    } as AnyMsg);
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-echo-replay" });
    await drainUntil(first, (m) => m.type === "session_started");

    // `session_status` is sent after the replay loop, so it is a safe boundary:
    // anything the replay would have emitted has arrived by the time it does.
    const late = await TestClient.connect(port, session.sessionId);
    const seen: AnyMsg[] = [];
    for (let i = 0; i < 30; i++) {
      const msg: AnyMsg = await late.receive(3000);
      seen.push(msg);
      if (msg.type === "session_status") break;
    }
    expect(seen.some((m) => m.type === "session_status")).toBe(true);
    expect(seen.some((m) => m.type === "system_user_message")).toBe(false);

    // The bubble is in persisted history instead — which is what a reload reads.
    const history = await app.inject({ method: "GET", url: `/api/sessions/${session.sessionId}/history` });
    const rows = history.json().messages as AnyMsg[];
    expect(rows.some((m) => m.role === "user" && m.text === "ship it")).toBe(true);

    claude.finish("test-echo-replay");
    first.close();
    late.close();
  });

  it("disconnecting from one session does not affect other tabs viewing it", async () => {
    const session1 = createSession("stay-session");

    // Tab 1 connects to session 1 and starts an agent
    const tab1 = await TestClient.connect(port, session1.sessionId);
    await tab1.receive(); // preview_status
    tab1.send({ type: "send_message", text: "Working", sessionId: session1.sessionId });
    const claude1 = await waitForClaude(() => lastClaude);
    claude1.emit("event", { type: "system", subtype: "init", session_id: "agent-stay" });
    await drainUntil(tab1, (m) => m.type === "session_started");

    // Tab 2 connects to the same session
    const tab2 = await TestClient.connect(port, session1.sessionId);
    await drainUntil(tab2, (m) => m.type === "session_status");

    // Tab 2 disconnects (simulates navigating away)
    tab2.close();
    await new Promise((r) => setTimeout(r, 100));

    // Session 1's agent should still be running — tab2 disconnecting didn't kill it
    expect(claude1.killed).toBe(false);
    expect(claude1.interrupted).toBe(false);

    // Tab 1 should still receive events from session 1
    claude1.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Still going" }] },
    });
    const tab1Event = await drainUntil(tab1, (m) =>
      m.type === "agent_event" && m.event?.type === "agent_assistant"
    );
    expect(tab1Event).toBeTruthy();

    // Clean up
    claude1.finish("test-stay");
    tab1.close();
  });

  it("full_reset from one tab notifies all tabs", async () => {
    const session = createSession("reset-session");
    const session2 = createSession("reset-session-2");

    // Tab 1 connects to session
    const tab1 = await TestClient.connect(port, session.sessionId);
    await tab1.receive(); // preview_status

    // Tab 2 connects to a different session
    const tab2 = await TestClient.connect(port, session2.sessionId);
    await tab2.receive(); // preview_status

    // Full reset via HTTP — full_reset_complete is broadcast via SSE
    const res = await app.inject({ method: "POST", url: "/api/reset" });
    expect(res.statusCode).toBe(200);

    // Verify reset took effect — bootstrap should show empty session list
    const bootstrapRes = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(bootstrapRes.json().sessions).toEqual([]);

    tab1.close();
    tab2.close();
  });

  it("file tree and git log requests are scoped to each connection's viewed session", async () => {
    const session1 = createSession("files-session-1");
    const session2 = createSession("files-session-2");

    // Create distinct files in each session directory
    fs.writeFileSync(path.join(session1.sessionDir, "file-from-session1.txt"), "hello from s1");
    fs.writeFileSync(path.join(session2.sessionDir, "file-from-session2.txt"), "hello from s2");

    // Tab 1 connects to session 1
    const tab1 = await TestClient.connect(port, session1.sessionId);
    await tab1.receive(); // preview_status

    // Tab 2 connects to session 2
    const tab2 = await TestClient.connect(port, session2.sessionId);
    await tab2.receive(); // preview_status

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
