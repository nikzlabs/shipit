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

  async function drainUntil(client: TestClient, predicate: (m: AnyMsg) => boolean, maxMsgs = 30): Promise<AnyMsg> {
    for (let i = 0; i < maxMsgs; i++) {
      const msg: AnyMsg = await client.receive(3000);
      if (predicate(msg)) return msg;
    }
    return null;
  }

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

    const tab1 = await TestClient.connect(port, session1.sessionId);
    await tab1.receive();

    const tab2 = await TestClient.connect(port, session2.sessionId);
    await tab2.receive();

    tab1.send({ type: "send_message", text: "Hello from tab 1", sessionId: session1.sessionId });
    const claude1 = await waitForClaude(() => lastClaude);
    claude1.emit("event", { type: "system", subtype: "init", session_id: "agent-mt-1" });

    const prevClaude = lastClaude;
    tab2.send({ type: "send_message", text: "Hello from tab 2", sessionId: session2.sessionId });
    const claude2 = await waitForClaude(() => lastClaude, prevClaude);
    claude2.emit("event", { type: "system", subtype: "init", session_id: "agent-mt-2" });

    expect(claude1).not.toBe(claude2);
    expect(claude1.killed).toBe(false);
    expect(claude2.killed).toBe(false);

    claude1.finish("test-mt-1");

    const statusRes = await app.inject({ method: "GET", url: `/api/sessions/${session2.sessionId}/status` });
    expect(statusRes.json().running).toBe(true);
    expect(claude2.killed).toBe(false);

    claude2.finish("test-mt-2");
    tab1.close();
    tab2.close();
  });

  it("two connections viewing the same session share agent events", async () => {
    const session = createSession("shared-session");

    const tab1 = await TestClient.connect(port, session.sessionId);
    await tab1.receive();

    tab1.send({ type: "send_message", text: "Hello", sessionId: session.sessionId });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-shared" });

    await drainUntil(tab1, (m) => m.type === "session_started");

    const tab2 = await TestClient.connect(port, session.sessionId);

    const status = await drainUntil(tab2, (m) => m.type === "session_status");
    expect(status).toBeTruthy();
    expect(status!.running).toBe(true);

    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Shared response" }] },
    });

    const tab1Event = await drainUntil(tab1, (m) =>
      m.type === "agent_event" && m.event?.type === "agent_assistant"
    );
    const tab2Event = await drainUntil(tab2, (m) =>
      m.type === "agent_event" && m.event?.type === "agent_assistant"
    );
    expect(tab1Event).toBeTruthy();
    expect(tab2Event).toBeTruthy();

    claude.finish("test-shared");
    tab1.close();
    tab2.close();
  });

  it("interrupt from one tab affects shared runner, both tabs notified", async () => {
    const session = createSession("interrupt-session");

    const tab1 = await TestClient.connect(port, session.sessionId);
    await tab1.receive();
    tab1.send({ type: "send_message", text: "Work on this", sessionId: session.sessionId });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-int" });

    await drainUntil(tab1, (m) => m.type === "session_started");

    const tab2 = await TestClient.connect(port, session.sessionId);
    await drainUntil(tab2, (m) => m.type === "session_status");

    tab2.send({ type: "interrupt_agent" } as any);

    const tab1Interrupt = await drainUntil(tab1, (m) => m.type === "agent_interrupted");
    const tab2Interrupt = await drainUntil(tab2, (m) => m.type === "agent_interrupted");
    expect(tab1Interrupt).toBeTruthy();
    expect(tab2Interrupt).toBeTruthy();

    expect(claude.interrupted).toBe(true);

    claude.finish("test-int");
    tab1.close();
    tab2.close();
  });

  it("a user message typed in one tab reaches the other tab's transcript", async () => {
    const session = createSession("echo-session");

    const desktop = await TestClient.connect(port, session.sessionId);
    await desktop.receive();
    const phone = await TestClient.connect(port, session.sessionId);
    await phone.receive();

    phone.send({
      type: "send_message",
      text: "ship it",
      sessionId: session.sessionId,
      requestId: "req-from-phone",
    } as AnyMsg);
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-echo" });

    const echo = await drainUntil(desktop, (m) => m.type === "system_user_message");
    expect(echo).toBeTruthy();
    expect(echo!.text).toBe("ship it");
    expect(echo!.sessionId).toBe(session.sessionId);
    expect(echo!.clientRequestId).toBe("req-from-phone");

    claude.finish("test-echo");
    desktop.close();
    phone.close();
  });

  it("persists the sender's request id on the user row so history and the echo agree", async () => {
    const session = createSession("echo-identity-session");

    const first = await TestClient.connect(port, session.sessionId);
    await first.receive();
    first.send({
      type: "send_message",
      text: "ship it",
      sessionId: session.sessionId,
      requestId: "req-first",
    } as AnyMsg);
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-echo-identity" });
    await drainUntil(first, (m) => m.type === "session_started");

    const history = await app.inject({ method: "GET", url: `/api/sessions/${session.sessionId}/history` });
    const rows = history.json().messages as AnyMsg[];
    const row = rows.find((m) => m.role === "user" && m.text === "ship it");
    expect(row).toBeTruthy();
    expect(row!.clientRequestId).toBe("req-first");

    const late = await TestClient.connect(port, session.sessionId);
    const replayed = await drainUntil(late, (m) => m.type === "system_user_message");
    expect(replayed).toBeTruthy();
    expect(replayed!.clientRequestId).toBe("req-first");

    claude.finish("test-echo-identity");
    first.close();
    late.close();
  });

  it("disconnecting from one session does not affect other tabs viewing it", async () => {
    const session1 = createSession("stay-session");

    const tab1 = await TestClient.connect(port, session1.sessionId);
    await tab1.receive();
    tab1.send({ type: "send_message", text: "Working", sessionId: session1.sessionId });
    const claude1 = await waitForClaude(() => lastClaude);
    claude1.emit("event", { type: "system", subtype: "init", session_id: "agent-stay" });
    await drainUntil(tab1, (m) => m.type === "session_started");

    const tab2 = await TestClient.connect(port, session1.sessionId);
    await drainUntil(tab2, (m) => m.type === "session_status");

    tab2.close();
    await new Promise((r) => setTimeout(r, 100));

    expect(claude1.killed).toBe(false);
    expect(claude1.interrupted).toBe(false);

    claude1.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Still going" }] },
    });
    const tab1Event = await drainUntil(tab1, (m) =>
      m.type === "agent_event" && m.event?.type === "agent_assistant"
    );
    expect(tab1Event).toBeTruthy();

    claude1.finish("test-stay");
    tab1.close();
  });

  it("full_reset from one tab notifies all tabs", async () => {
    const session = createSession("reset-session");
    const session2 = createSession("reset-session-2");

    const tab1 = await TestClient.connect(port, session.sessionId);
    await tab1.receive();

    const tab2 = await TestClient.connect(port, session2.sessionId);
    await tab2.receive();

    const res = await app.inject({ method: "POST", url: "/api/reset" });
    expect(res.statusCode).toBe(200);

    const bootstrapRes = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(bootstrapRes.json().sessions).toEqual([]);

    tab1.close();
    tab2.close();
  });

  it("file tree and git log requests are scoped to each connection's viewed session", async () => {
    const session1 = createSession("files-session-1");
    const session2 = createSession("files-session-2");

    fs.writeFileSync(path.join(session1.sessionDir, "file-from-session1.txt"), "hello from s1");
    fs.writeFileSync(path.join(session2.sessionDir, "file-from-session2.txt"), "hello from s2");

    const tab1 = await TestClient.connect(port, session1.sessionId);
    await tab1.receive();

    const tab2 = await TestClient.connect(port, session2.sessionId);
    await tab2.receive();

    const treeRes1 = await app.inject({ method: "GET", url: `/api/sessions/${session1.sessionId}/files` });
    const files1 = JSON.stringify(treeRes1.json().tree);
    expect(files1).toContain("file-from-session1.txt");
    expect(files1).not.toContain("file-from-session2.txt");

    const treeRes2 = await app.inject({ method: "GET", url: `/api/sessions/${session2.sessionId}/files` });
    const files2 = JSON.stringify(treeRes2.json().tree);
    expect(files2).toContain("file-from-session2.txt");
    expect(files2).not.toContain("file-from-session1.txt");

    tab1.close();
    tab2.close();
  });
});
