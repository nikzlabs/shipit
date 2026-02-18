import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../auth.js";
import { ViteManager } from "../vite-manager.js";
import { ClaudeProcess } from "../claude.js";
import { FileWatcher } from "../file-watcher.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubViteManager,
  StubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
  waitForClaude,
} from "./test-helpers.js";

describe("Integration: Claude message flow", () => {
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

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager,
      viteManager: new StubViteManager() as unknown as ViteManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      claudeFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as unknown as ClaudeProcess;
      },
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      workspaceDir: tmpDir,
      serveStatic: false,
      startVite: false,
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
    expect((msg as any).message).toContain("Claude process error");
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

  it("sending a new message kills the previous ClaudeProcess", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    // First message
    client.send({ type: "send_message", text: "First" });
    await waitForClaude(() => lastClaude);
    const firstClaude = lastClaude;

    // Second message before first completes
    client.send({ type: "send_message", text: "Second" });
    await waitForClaude(() => lastClaude, firstClaude);

    expect(firstClaude.killed).toBe(true);
    expect(lastClaude.lastPrompt).toBe("Second");
    expect(lastClaude).not.toBe(firstClaude);

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

  it("disconnecting kills any running ClaudeProcess", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "test" });
    await waitForClaude(() => lastClaude);
    const claude = lastClaude;

    // Close the websocket — should kill the process
    client.close();
    await new Promise((r) => setTimeout(r, 100));

    expect(claude.killed).toBe(true);
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

  it("accumulates tool use blocks across multiple assistant events in persisted chat history", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Edit some files" });
    await waitForClaude(() => lastClaude);

    // System init creates the session
    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "tool-accum-session",
    });
    await client.receiveSkipLogs(); // claude_event
    const sessionStarted = await client.receiveSkipLogs(); // session_started
    const appSessionId = (sessionStarted as any).session.id;

    // First assistant event with text + one tool call
    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "I'll read and edit the file." },
          {
            type: "tool_use",
            id: "tool-1",
            name: "Read",
            input: { file_path: "/app.ts" },
          },
        ],
      },
    });
    await client.receiveSkipLogs(); // claude_event

    // Second assistant event with another tool call (simulates a follow-up action)
    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: " Now editing." },
          {
            type: "tool_use",
            id: "tool-2",
            name: "Edit",
            input: { file_path: "/app.ts", old_string: "x", new_string: "y" },
          },
        ],
      },
    });
    await client.receiveSkipLogs(); // claude_event

    // Third assistant event with yet another tool call
    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool-3",
            name: "Write",
            input: { file_path: "/new.ts", content: "export default {}" },
          },
        ],
      },
    });
    await client.receiveSkipLogs(); // claude_event

    // Complete the turn
    lastClaude.finish("tool-accum-session");
    await client.receiveSkipLogs(); // result claude_event

    // Verify persisted chat history has ALL tool calls, not just the last one
    const messages = chatHistoryManager.load(appSessionId);
    // messages[0] = user message, messages[1] = assistant message
    const assistantMsg = messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.text).toBe("I'll read and edit the file. Now editing.");
    expect(assistantMsg!.toolUse).toHaveLength(3);
    expect(assistantMsg!.toolUse![0].id).toBe("tool-1");
    expect(assistantMsg!.toolUse![0].name).toBe("Read");
    expect(assistantMsg!.toolUse![1].id).toBe("tool-2");
    expect(assistantMsg!.toolUse![1].name).toBe("Edit");
    expect(assistantMsg!.toolUse![2].id).toBe("tool-3");
    expect(assistantMsg!.toolUse![2].name).toBe("Write");

    client.close();
  });

  it("relays all tool use blocks to client across multiple assistant events", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Do parallel work" });
    await waitForClaude(() => lastClaude);

    // System init
    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "relay-session",
    });
    await client.receiveSkipLogs(); // claude_event
    await client.receiveSkipLogs(); // session_started

    // First assistant event with a tool call
    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Reading file" },
          {
            type: "tool_use",
            id: "t1",
            name: "Read",
            input: { file_path: "/a.ts" },
          },
        ],
      },
    });
    const event1 = await client.receiveSkipLogs();
    expect(event1.type).toBe("claude_event");
    expect((event1 as any).event.type).toBe("assistant");
    const content1 = (event1 as any).event.message.content;
    expect(content1).toHaveLength(2);
    expect(content1[0]).toMatchObject({ type: "text", text: "Reading file" });
    expect(content1[1]).toMatchObject({ type: "tool_use", id: "t1", name: "Read" });

    // Second assistant event with another tool call
    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: "Edit",
            input: { file_path: "/a.ts", old_string: "x", new_string: "y" },
          },
        ],
      },
    });
    const event2 = await client.receiveSkipLogs();
    expect(event2.type).toBe("claude_event");
    // The second event should also contain its tool_use block
    const content2 = (event2 as any).event.message.content;
    expect(content2).toHaveLength(1);
    expect(content2[0]).toMatchObject({ type: "tool_use", id: "t2", name: "Edit" });

    client.close();
  });
});
