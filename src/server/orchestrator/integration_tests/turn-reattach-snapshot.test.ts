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

describe("Integration: mid-turn reattach snapshot", () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-reattach-"));
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

  async function startTurnWithOneGroup(): Promise<TestClient> {
    const client = await TestClient.connect(port);
    await client.receive();
    client.send({ type: "send_message", text: "Do the thing" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession("reattach-session");
    await client.receiveType("session_started");

    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "GROUP-ONE" },
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } },
        ],
      },
    });
    lastClaude.emit("event", {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "bytes" }] },
    });
    await settle();
    return client;
  }

  function emitGroupTwo(): void {
    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "GROUP-TWO" },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } },
        ],
      },
    });
    lastClaude.emit("event", {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "out" }] },
    });
  }

  async function drainAll(client: TestClient): Promise<AnyMsg[]> {
    const msgs: AnyMsg[] = [];
    try {
      for (let i = 0; i < 40; i++) msgs.push(await client.receive(300));
    } catch { /* drained */ }
    return msgs;
  }

  it("sends the whole running turn when a persist lands between the history read and the attach", async () => {
    const client = await startTurnWithOneGroup();
    const sessionId = client.sessionId;

    client.close();
    await settle();

    const histRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/history`);
    const hist = await histRes.json() as { messages: AnyMsg[] };
    expect(hist.messages.map((m) => m.text)).toEqual(["Do the thing", "GROUP-ONE"]);

    emitGroupTwo();
    await settle();

    const back = await TestClient.connect(port, sessionId);
    const replayed = await drainAll(back);

    const snapshot = replayed.find((m) => m.type === "turn_snapshot");
    expect(snapshot).toBeDefined();
    expect(snapshot.sessionId).toBe(sessionId);
    expect(snapshot.messages.map((m: AnyMsg) => m.text)).toEqual(["GROUP-ONE", "GROUP-TWO"]);
    expect(snapshot.messages.every((m: AnyMsg) => m.inProgress)).toBe(true);
    back.close();
  });

  it("does not replay agent events on top of the snapshot (no duplicated turn content)", async () => {
    const client = await startTurnWithOneGroup();
    const sessionId = client.sessionId;
    client.close();
    await settle();

    lastClaude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "TAIL-TEXT" }] },
    });
    await settle();

    const back = await TestClient.connect(port, sessionId);
    const replayed = await drainAll(back);

    const snapshot = replayed.find((m) => m.type === "turn_snapshot");
    expect(snapshot.messages.map((m: AnyMsg) => m.text)).toEqual(["GROUP-ONE", "TAIL-TEXT"]);
    expect(replayed.filter((m) => m.type === "agent_event")).toEqual([]);
    back.close();
  });

  it("does not replay a background-task message on reattach", async () => {
    const client = await startTurnWithOneGroup();
    const sessionId = client.sessionId;

    lastClaude.emit("event", {
      type: "agent_background_tasks",
      tasks: [{ id: "bg-1", description: "shipit agent run --agent codex" }],
    });
    await settle();
    expect(
      (await drainAll(client)).some((m) => m.type === "background_tasks"),
    ).toBe(true);

    client.close();
    await settle();

    const back = await TestClient.connect(port, sessionId);
    const replayed = await drainAll(back);

    expect(replayed.filter((m) => m.type === "background_tasks")).toEqual([]);
    back.close();
  });

  it("sends no snapshot when no turn is running", async () => {
    const client = await startTurnWithOneGroup();
    const sessionId = client.sessionId;
    lastClaude.finish("reattach-session");
    await settle(250);
    client.close();
    await settle();

    const back = await TestClient.connect(port, sessionId);
    const replayed = await drainAll(back);

    expect(replayed.find((m) => m.type === "turn_snapshot")).toBeUndefined();
    back.close();
  });
});
