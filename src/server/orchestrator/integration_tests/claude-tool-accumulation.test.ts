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

describe("Integration: Claude tool use accumulation", () => {
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
      // Ignore cleanup errors — temp dir will be cleaned by OS
    }
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
    const sessionStarted = await client.receiveType("session_started");
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

    // Complete the turn and wait for persistence to finish
    lastClaude.finish("tool-accum-session");
    // Drain remaining WS messages (session_agent_finished is SSE-only)
    try { for (let i = 0; i < 20; i++) await client.receive(300); } catch { /* timeout expected */ }

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
    await client.receiveType("session_started");

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
    const event1 = await client.receiveType("agent_event");
    expect(event1.type).toBe("agent_event");
    expect((event1 as any).event.type).toBe("agent_assistant");
    const content1 = (event1 as any).event.content;
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
    const event2 = await client.receiveType("agent_event");
    expect(event2.type).toBe("agent_event");
    // The second event should also contain its tool_use block
    const content2 = (event2 as any).event.content;
    expect(content2).toHaveLength(1);
    expect(content2[0]).toMatchObject({ type: "tool_use", id: "t2", name: "Edit" });

    client.close();
  });
});
