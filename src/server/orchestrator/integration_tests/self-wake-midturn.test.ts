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

describe("Integration: background-task notification mid-turn", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let lastClaude: FakeClaudeProcess = null as never;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as never;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-selfwake-"));
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
        return lastClaude as never;
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
    } catch { /* ignore cleanup errors */ }
  });

  const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

  it("keeps the running turn's earlier messages in chat history", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = client.sessionId;

    client.send({ type: "send_message", text: "Run the suite in the background" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession("self-wake-session");
    await client.receiveType("session_started");

    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "GROUP-ONE" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test", run_in_background: true } },
        ],
      },
    });
    lastClaude.emit("event", {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "started" }] },
    });
    await settle();
    expect(chatHistoryManager.load(sessionId).map((m) => m.text))
      .toEqual(["Run the suite in the background", "GROUP-ONE"]);

    lastClaude.emit("event", {
      type: "agent_self_wake",
      taskId: "bg-1",
      summary: "npm test finished",
      status: "completed",
    });
    await settle();

    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "GROUP-TWO" },
          { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/log.txt" } },
        ],
      },
    });
    lastClaude.emit("event", {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] },
    });
    await settle();

    expect(chatHistoryManager.load(sessionId).map((m) => m.text))
      .toEqual(["Run the suite in the background", "GROUP-ONE", "GROUP-TWO"]);

    lastClaude.finish("self-wake-session");
    await settle(250);
    expect(chatHistoryManager.load(sessionId).map((m) => m.text))
      .toEqual(["Run the suite in the background", "GROUP-ONE", "GROUP-TWO"]);
    client.close();
  });

  it("still gives a genuinely self-woken turn a clean accumulator", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = client.sessionId;

    client.send({ type: "send_message", text: "Kick off the job" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession("self-wake-session-2");
    await client.receiveType("session_started");

    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "TURN-ONE" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 1", run_in_background: true } },
        ],
      },
    });
    lastClaude.emit("event", {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "started" }] },
    });
    lastClaude.finish("self-wake-session-2");
    await settle(250);

    lastClaude.emit("event", {
      type: "agent_self_wake",
      taskId: "bg-1",
      summary: "done",
      status: "completed",
    });
    await settle();
    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "WAKE-TURN" },
          { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/out.txt" } },
        ],
      },
    });
    lastClaude.emit("event", {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] },
    });
    await settle();

    expect(chatHistoryManager.load(sessionId).map((m) => m.text))
      .toEqual(["Kick off the job", "TURN-ONE", "WAKE-TURN"]);
    client.close();
  });

  it("reports outstanding background tasks in GET /history", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = client.sessionId;

    client.send({ type: "send_message", text: "Kick off the job" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession("bg-history-session");
    await client.receiveType("session_started");

    // Model a resident process; this fixture disables live steering.
    const runner = app.runnerRegistry.get(sessionId)!;
    runner.isStreamingActive = true;

    lastClaude.emit("event", {
      type: "agent_background_tasks",
      tasks: [{ id: "bg-1", type: "local_bash", description: "npm test" }],
    });
    // End the turn without exiting the process that owns the background task.
    lastClaude.emit("event", { type: "result", subtype: "success", session_id: "bg-history-session" });
    await settle(250);

    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/history`);
    const body = await res.json() as { agentRunning: boolean; backgroundTasks: string[] };
    expect(body.agentRunning).toBe(false);
    expect(body.backgroundTasks).toEqual(["npm test"]);

    lastClaude.emit("event", { type: "agent_background_tasks", tasks: [] });
    await settle();
    const after = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/history`);
    expect(((await after.json()) as { backgroundTasks: string[] }).backgroundTasks).toEqual([]);
    client.close();
  });
});
