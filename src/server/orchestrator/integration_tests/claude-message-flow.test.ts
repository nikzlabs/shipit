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
  createTestDatabaseManager,
  createTestCredentialStore,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

describe("Integration: Claude message flow — basics", () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-claude-flow-"));

    sessionManager = new SessionManager(dbManager);
    chatHistoryManager = new ChatHistoryManager(dbManager);

    // The helper disables live steering so mid-turn messages enter the queue.
    const credentialStore = createTestCredentialStore(tmpDir);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager,
      credentialStore,
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
      // Ignore cleanup errors.
    }
  });

  it("send_message creates a ClaudeProcess and relays events", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Hello Claude" });

    await waitForClaude(() => lastClaude);
    expect(lastClaude.lastPrompt).toBe("Hello Claude");

    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "test-session-123",
      tools: ["Write"],
    });

    const agentEvent = await client.receiveType("agent_event");
    expect(agentEvent).toBeDefined();
    expect(agentEvent.type).toBe("agent_event");
    expect((agentEvent as any).event.type).toBe("agent_init");

    const sessionStarted = await client.receiveType("session_started");
    expect((sessionStarted as any).session.id).toBeTruthy();
    expect((sessionStarted as any).session.title).toBeTruthy();
    // Init alone cannot confirm a resumable conversation.
    expect((sessionStarted as any).session.agentSessionId).toBeUndefined();

    const appSessionId = (sessionStarted as any).session.id as string;
    lastClaude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "hello back" }] },
      session_id: "test-session-123",
    });
    await client.receiveType("agent_event");
    expect(sessionManager.get(appSessionId)?.agentSessionId).toBe("test-session-123");

    client.close();
  });

  it("'No conversation found' clears the guarded pointer and retries fresh without persisting the doomed init", async () => {
    sessionManager.track("loop-session", "Stuck session", tmpDir);
    sessionManager.setAgentSessionId("loop-session", "recovered-real-id");

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "anything", sessionId: "loop-session" });
    await waitForClaude(() => lastClaude);
    const rejectedProcess = lastClaude;

    rejectedProcess.emit("log", "stderr", "No conversation found with session ID: recovered-real-id");
    rejectedProcess.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "doomed-fresh-uuid",
      tools: [],
    });
    await waitForClaude(() => lastClaude !== rejectedProcess ? lastClaude : null);
    expect(rejectedProcess.killed).toBe(true);
    expect(lastClaude.lastPrompt).toBe("anything");
    expect(lastClaude.lastSessionId).toBeUndefined();
    expect(sessionManager.get("loop-session")?.agentSessionId).toBeUndefined();

    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "fresh-conversation-id",
      tools: [],
    });
    lastClaude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "recovered" }] },
      session_id: "fresh-conversation-id",
    });
    await client.receiveType("agent_event");
    await client.receiveType("agent_event");
    expect(sessionManager.get("loop-session")?.agentSessionId).toBe("fresh-conversation-id");

    client.close();
  });

  it("send_message with sessionId passes it to ClaudeProcess.run()", async () => {
    sessionManager.track("existing-session", "Test session", tmpDir);
    sessionManager.setAgentSessionId("existing-session", "agent-session-abc");

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Resume", sessionId: "existing-session" });
    await waitForClaude(() => lastClaude);

    expect(lastClaude.lastSessionId).toBe("agent-session-abc");

    client.close();
  });

  it("claude done event triggers git auto-commit", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Make a file" });
    await waitForClaude(() => lastClaude);

    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "test-session",
    });

    const sessionMsg = await client.receiveType("session_started");
    const sessionDir = (sessionMsg as any).session.workspaceDir;

    fs.writeFileSync(path.join(sessionDir, "new-file.txt"), "auto commit me");

    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "I created new-file.txt for you" }],
      },
    });

    lastClaude.emit("event", { type: "result", subtype: "success", session_id: "test-session" });
    lastClaude.emit("done", 0);

    const msg = await client.receiveType("git_committed");
    expect((msg as any).message).toBe("I created new-file.txt for you");
    expect((msg as any).hash).toBeTruthy();

    client.close();
  });

  it("claude error event is relayed to client", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "fail" });
    await waitForClaude(() => lastClaude);

    lastClaude.emit("error", new Error("spawn ENOENT"));

    const msg = await client.receiveType("error");
    expect((msg as any).message).toContain("Agent process error");
    expect((msg as any).message).toContain("spawn ENOENT");

    client.close();
  });

  it("claude error preserves the partial turn in chat history", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "do work" });
    await waitForClaude(() => lastClaude);

    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "test-session",
    });
    const sessionMsg = await client.receiveType("session_started");
    const sessionId = (sessionMsg as any).session.id;

    lastClaude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Working on it" }] },
    });
    await client.receiveType("agent_event");

    lastClaude.emit("error", new Error("spawn ENOENT"));
    await client.receiveType("error");

    const history = chatHistoryManager.load(sessionId);
    const texts = history.map((m) => m.text);
    expect(texts).toContain("Working on it");
    expect(texts.some((t) => t.includes("spawn ENOENT"))).toBe(true);
    expect(history.every((m) => !m.inProgress)).toBe(true);

    client.close();
  });

  it("claude process exit without result sends error to client", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Hello" });
    await waitForClaude(() => lastClaude);

    lastClaude.emit("done", 1);

    const msg = await client.receiveType("error");
    expect((msg as any).message).toContain("exited with code 1");

    client.close();
  });

  it("claude process exit code 0 without result sends error to client", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Hello" });
    await waitForClaude(() => lastClaude);

    lastClaude.emit("done", 0);

    const msg = await client.receiveType("error");
    expect((msg as any).message).toContain("ended without a response");

    client.close();
  });

  it("sending a new message while Claude is running queues it instead of killing", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "First" });
    await waitForClaude(() => lastClaude);
    const firstClaude = lastClaude;

    client.send({ type: "send_message", text: "Second" });

    let queued: any = null;
    for (let i = 0; i < 20 && !queued; i++) {
      const msg = await client.receive(2000) as any;
      if (msg.type === "message_queued") queued = msg;
    }

    expect(queued).toMatchObject({ type: "message_queued", text: "Second", position: 1 });
    expect(firstClaude.killed).toBe(false);
    expect(lastClaude).toBe(firstClaude);

    client.close();
  });

  it("multiple clients each receive their own preview_status on connect", async () => {
    const client1 = await TestClient.connect(port);
    const msg1 = await client1.receiveType("preview_status");
    expect(msg1.type).toBe("preview_status");

    const client2 = await TestClient.connect(port);
    const msg2 = await client2.receiveType("preview_status");
    expect(msg2.type).toBe("preview_status");

    client1.close();
    client2.close();
  });

  it("disconnecting detaches from runner but does NOT kill the agent (persistent runner)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "test" });
    await waitForClaude(() => lastClaude);
    const claude = lastClaude;

    client.close();
    await new Promise((r) => setTimeout(r, 100));

    expect(claude.killed).toBe(false);
  });

  it("result event updates session lastUsedAt", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "test" });
    await waitForClaude(() => lastClaude);

    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "track-session",
    });
    await client.receiveType("session_started");

    const sessionsBefore = sessionManager.list();
    const lastUsedBefore = sessionsBefore[0].lastUsedAt;

    await new Promise((r) => setTimeout(r, 10));

    lastClaude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "track-session",
    });

    const sessionsAfter = sessionManager.list();
    expect(sessionsAfter[0].lastUsedAt >= lastUsedBefore).toBe(true);

    client.close();
  });
});
