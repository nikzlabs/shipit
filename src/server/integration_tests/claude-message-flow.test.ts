import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { CredentialStore } from "../credential-store.js";
import { AuthManager } from "../auth.js";
import { PreviewManager } from "../preview-manager.js";
import { ClaudeProcess } from "../claude.js";
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

describe("Integration: Claude message flow — basics", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  /** Most recently created FakeClaudeProcess — set by claudeFactory. */
  let lastClaude: FakeClaudeProcess = null as any;

  beforeEach(async () => {
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-claude-flow-"));

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);
    chatHistoryManager = new ChatHistoryManager(path.join(tmpDir, "chat-history"));

    // Pre-populate credential store with a default identity so sessions
    // don't trigger git_identity_required prompts during unrelated tests.
    const credentialStore = new CredentialStore(path.join(tmpDir, "credentials"));
    credentialStore.setGitIdentity("Test User", "test@example.com");

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager,
      credentialStore,
      previewManager: new StubPreviewManager() as unknown as PreviewManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      claudeFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as unknown as ClaudeProcess;
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

    // Should receive claude_event + session_started (skip any log_entry messages)
    const claudeEvent = await client.receiveSkipLogs();
    expect(claudeEvent).toBeDefined();
    expect(claudeEvent.type).toBe("claude_event");
    expect((claudeEvent as any).event.type).toBe("system");

    const sessionStarted = await client.receiveSkipLogs();
    expect(sessionStarted).toBeDefined();
    expect(sessionStarted.type).toBe("session_started");
    // Session ID is now an app-generated UUID (not the agent's session_id)
    expect((sessionStarted as any).session.id).toBeTruthy();
    expect((sessionStarted as any).session.title).toBe("Hello Claude");
    expect((sessionStarted as any).session.agentSessionId).toBe("test-session-123");

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

    // Consume the claude_event for init and the session_started message
    await client.receiveSkipLogs(); // claude_event (init)
    const sessionMsg = await client.receiveSkipLogs(); // session_started
    expect(sessionMsg.type).toBe("session_started");
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

    // Consume the claude_event for the assistant message (skip log_entry messages)
    await client.receiveSkipLogs();

    // Simulate Claude finishing — this triggers auto-commit
    lastClaude.emit("event", { type: "result", subtype: "success", session_id: "test-session" });
    lastClaude.emit("done", 0);
    await client.receiveSkipLogs(); // consume the result claude_event

    // Wait for the async auto-commit (skip log_entry messages)
    const msg = await client.receiveSkipLogs();

    expect(msg.type).toBe("git_committed");
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

    // Skip log_entry messages to get the error
    const msg = await client.receiveSkipLogs();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("Agent process error");
    expect((msg as any).message).toContain("spawn ENOENT");

    client.close();
  });

  it("claude process exit without result sends error to client", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Hello" });
    await waitForClaude(() => lastClaude);

    // Process exits with non-zero code and no result event
    lastClaude.emit("done", 1);

    const msg = await client.receiveSkipLogs();

    expect(msg.type).toBe("error");
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

    const msg = await client.receiveSkipLogs();

    expect(msg.type).toBe("error");
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
    // Consume claude_event + session_started (skip log_entry messages)
    await client.receiveSkipLogs(); // claude_event
    await client.receiveSkipLogs(); // session_started

    const sessionsBefore = sessionManager.list();
    const lastUsedBefore = sessionsBefore[0].lastUsedAt;

    // Wait a tick so timestamp differs
    await new Promise((r) => setTimeout(r, 10));

    // Result event should update lastUsedAt
    lastClaude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "track-session",
    });
    // Consume the claude_event (skip log_entry messages)
    await client.receiveSkipLogs();

    const sessionsAfter = sessionManager.list();
    expect(sessionsAfter[0].lastUsedAt >= lastUsedBefore).toBe(true);

    client.close();
  });
});
