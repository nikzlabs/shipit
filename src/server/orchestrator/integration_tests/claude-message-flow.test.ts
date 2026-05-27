import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../auth.js";
import { initGlobalGitConfig, setGitIdentity } from "../git-config.js";


import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

describe("Integration: Claude message flow — basics", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  /** Most recently created FakeClaudeProcess — set by agentFactory. */
  let lastClaude: FakeClaudeProcess = null as any;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-claude-flow-"));

    sessionManager = new SessionManager(dbManager);
    chatHistoryManager = new ChatHistoryManager(dbManager);

    // Set up global git config so sessions inherit identity automatically.
    initGlobalGitConfig(path.join(tmpDir, "credentials"));
    setGitIdentity("Test User", "test@example.com");

    app = await buildApp({
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
      // Ignore cleanup errors — temp dir will be cleaned by OS
    }
  });

  it("send_message creates a ClaudeProcess and relays events", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Hello Claude" });

    await waitForClaude(() => lastClaude);
    expect(lastClaude.lastPrompt).toBe("Hello Claude");

    // Simulate Claude emitting a system init event
    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "test-session-123",
      tools: ["Write"],
    });

    // Should receive agent_event (skip any log_entry messages)
    const agentEvent = await client.receiveType("agent_event");
    expect(agentEvent).toBeDefined();
    expect(agentEvent.type).toBe("agent_event");
    expect((agentEvent as any).event.type).toBe("agent_init");

    const sessionStarted = await client.receiveType("session_started");
    // Session ID is now an app-generated UUID (not the agent's session_id)
    expect((sessionStarted as any).session.id).toBeTruthy();
    // Session title is set at creation time (auto-created by TestClient), not from prompt text
    expect((sessionStarted as any).session.title).toBeTruthy();
    // docs/153 Fix 2 — agent_session_id is NOT persisted on agent_init.
    // The listener stashes the init's session_id and flushes it on the
    // first agent_assistant (or the agent_result fallback). Until then,
    // session.agentSessionId in the session_started event remains the
    // session's previous value (null for a fresh session here). This
    // prevents a doomed init UUID — emitted right before the CLI exits
    // with "No conversation found" — from overwriting a recovered id.
    expect((sessionStarted as any).session.agentSessionId).toBeUndefined();

    // After the first assistant content arrives, the stash flushes to DB.
    const appSessionId = (sessionStarted as any).session.id as string;
    lastClaude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "hello back" }] },
      session_id: "test-session-123",
    });
    // Drain the agent_event message that the assistant emit produces so the
    // listener's synchronous setAgentSessionId has run by the time we read.
    await client.receiveType("agent_event");
    expect(sessionManager.get(appSessionId)?.agentSessionId).toBe("test-session-123");

    client.close();
  });

  // docs/153 Fix 2 — when `--resume <id>` fails with "No conversation found",
  // the CLI still emits an agent_init with a fresh UUID right before exiting.
  // The listener must NOT persist that doomed UUID, otherwise it overwrites
  // the previously-stored id (or a freshly-recovered one) and every
  // subsequent retry compounds the loss into a self-perpetuating loop.

  it("'No conversation found' stderr blocks the doomed init UUID from clobbering the DB", async () => {
    // Pre-register a session with an existing agentSessionId — this is what
    // the listener must protect.
    sessionManager.track("loop-session", "Stuck session", tmpDir);
    sessionManager.setAgentSessionId("loop-session", "recovered-real-id");

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "anything", sessionId: "loop-session" });
    await waitForClaude(() => lastClaude);

    // 1. CLI fails to resume → emits the missing-conversation stderr.
    lastClaude.emit("log", "stderr", "No conversation found with session ID: recovered-real-id");
    // 2. CLI emits a fresh init UUID just before exiting.
    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "doomed-fresh-uuid",
      tools: [],
    });
    // Let both messages propagate to the listener.
    await client.receiveType("error");
    await client.receiveType("agent_event");

    // DB row unchanged — the doomed UUID didn't land.
    expect(sessionManager.get("loop-session")?.agentSessionId).toBe("recovered-real-id");

    client.close();
  });

  it("send_message with sessionId passes it to ClaudeProcess.run()", async () => {
    // Pre-register the session with an agentSessionId so the server can look it up.
    // The server resolves msg.sessionId (app session ID) → session.agentSessionId (CLI session ID).
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

    // Emit init event to establish the session — this fires session_started
    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "test-session",
    });

    // Consume the session_started message
    const sessionMsg = await client.receiveType("session_started");
    const sessionDir = (sessionMsg as any).session.workspaceDir;

    // Create a file in the session directory that will be committed on done
    fs.writeFileSync(path.join(sessionDir, "new-file.txt"), "auto commit me");

    // Simulate assistant text (used as commit message)
    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "I created new-file.txt for you" }],
      },
    });

    // The agent_event for the assistant message is auto-skipped by receiveSkipLogs

    // Simulate Claude finishing — this triggers auto-commit
    lastClaude.emit("event", { type: "result", subtype: "success", session_id: "test-session" });
    lastClaude.emit("done", 0);

    // Wait for the async auto-commit
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

    // Agent produces some work before crashing...
    lastClaude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Working on it" }] },
    });
    await client.receiveType("agent_event");

    // ...then the process errors mid-turn.
    lastClaude.emit("error", new Error("spawn ENOENT"));
    await client.receiveType("error");

    // The partial turn must survive — not be wiped by the old clearInProgress().
    const history = chatHistoryManager.load(sessionId);
    const texts = history.map((m) => m.text);
    expect(texts).toContain("Working on it");
    expect(texts.some((t) => t.includes("spawn ENOENT"))).toBe(true);
    // Nothing should be left flagged in-progress.
    expect(history.every((m) => !m.inProgress)).toBe(true);

    client.close();
  });

  it("claude process exit without result sends error to client", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Hello" });
    await waitForClaude(() => lastClaude);

    // Process exits with non-zero code and no result event
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

    // Process exits with code 0 but no result event (e.g. auth issue)
    lastClaude.emit("done", 0);

    const msg = await client.receiveType("error");
    expect((msg as any).message).toContain("ended without a response");

    client.close();
  });

  it("sending a new message while Claude is running queues it instead of killing", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    // First message
    client.send({ type: "send_message", text: "First" });
    await waitForClaude(() => lastClaude);
    const firstClaude = lastClaude;

    // Second message before first completes — should be queued, NOT kill the first
    client.send({ type: "send_message", text: "Second" });

    // Drain messages until we see message_queued
    let queued: any = null;
    for (let i = 0; i < 20 && !queued; i++) {
      const msg = await client.receive(2000) as any;
      if (msg.type === "message_queued") queued = msg;
    }

    expect(queued).toMatchObject({ type: "message_queued", text: "Second", position: 1 });
    // First Claude should NOT have been killed
    expect(firstClaude.killed).toBe(false);
    // A second Claude process should NOT have been started yet
    expect(lastClaude).toBe(firstClaude);

    client.close();
  });

  it("multiple clients each receive their own preview_status on connect", async () => {
    const client1 = await TestClient.connect(port);
    const msg1 = await client1.receive();
    expect(msg1.type).toBe("preview_status");

    const client2 = await TestClient.connect(port);
    const msg2 = await client2.receive();
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

    // Close the websocket — runner keeps going (persistent session runner)
    client.close();
    await new Promise((r) => setTimeout(r, 100));

    // Agent process should NOT be killed — that's the key behavioral change
    expect(claude.killed).toBe(false);
  });

  it("result event updates session lastUsedAt", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "test" });
    await waitForClaude(() => lastClaude);

    // Init event creates the session
    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "track-session",
    });
    await client.receiveType("session_started");

    const sessionsBefore = sessionManager.list();
    const lastUsedBefore = sessionsBefore[0].lastUsedAt;

    // Wait a tick so timestamp differs
    await new Promise((r) => setTimeout(r, 10));

    // Result event should update lastUsedAt (agent_event is auto-skipped by receiveSkipLogs)
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
