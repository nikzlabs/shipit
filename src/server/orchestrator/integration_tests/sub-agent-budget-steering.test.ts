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
import type { CredentialStore } from "../credential-store.js";
import { DatabaseManager } from "../../shared/database.js";
import { SUB_AGENT_PER_TURN_CAP } from "../services/sub-agent.js";

describe("Integration: sub-agent spawn budget vs live steering", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let credentialStore: CredentialStore;
  let lastClaude: FakeClaudeProcess = null as never;
  let dbManager: DatabaseManager;
  let chatHistoryManager: ChatHistoryManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as never;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-budget-steer-"));
    credentialStore = createTestCredentialStore(tmpDir);
    credentialStore.setLiveSteering(true);

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
      chatHistoryManager: (chatHistoryManager = new ChatHistoryManager(dbManager)),
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
    } catch { /* Cleanup may race background work. */ }
  });

  const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

  it("refills the budget when the user steers a message into a running turn", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = client.sessionId;

    client.send({ type: "send_message", text: "Review this with codex" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession("steer-budget-session");
    await client.receiveType("session_started");

    const runner = app.runnerRegistry.get(sessionId)!;
    expect(runner.subAgentSpawnsThisTurn).toBe(0);

    runner.subAgentSpawnsThisTurn = SUB_AGENT_PER_TURN_CAP;
    expect(runner.running).toBe(true);

    client.send({ type: "send_message", text: "Now get a second opinion too" });
    await settle();

    expect(lastClaude.stdinData.some((m) => m.includes("second opinion"))).toBe(true);
    expect(runner.subAgentSpawnsThisTurn).toBe(0);

    client.close();
  });

  it("does not refill the budget when a background task finishes mid-turn", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = client.sessionId;

    client.send({ type: "send_message", text: "Background the consult" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession("midturn-budget-session");
    await client.receiveType("session_started");

    const runner = app.runnerRegistry.get(sessionId)!;
    runner.subAgentSpawnsThisTurn = SUB_AGENT_PER_TURN_CAP;

    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "GROUP-ONE" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "shipit agent run", run_in_background: true } },
        ],
      },
    });
    lastClaude.emit("event", {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "started" }] },
    });
    await settle();

    lastClaude.emit("event", {
      type: "agent_self_wake",
      taskId: "bg-1",
      summary: "consult finished",
      status: "completed",
    });
    await settle();

    expect(runner.subAgentSpawnsThisTurn).toBe(SUB_AGENT_PER_TURN_CAP);
    expect(chatHistoryManager.load(sessionId).map((m) => m.text))
      .toEqual(["Background the consult", "GROUP-ONE"]);

    client.close();
  });

  it("refills the budget for a genuinely self-woken turn", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = client.sessionId;

    client.send({ type: "send_message", text: "Background the consult" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession("wake-budget-session");
    await client.receiveType("session_started");

    const runner = app.runnerRegistry.get(sessionId)!;
    runner.subAgentSpawnsThisTurn = SUB_AGENT_PER_TURN_CAP;

    lastClaude.emit("event", { type: "result", subtype: "success", session_id: "wake-budget-session" });
    await settle(250);
    lastClaude.emit("event", {
      type: "agent_self_wake",
      taskId: "bg-1",
      summary: "consult finished",
      status: "completed",
    });
    await settle();

    expect(runner.running).toBe(true);
    expect(runner.subAgentSpawnsThisTurn).toBe(0);

    client.close();
  });
});
