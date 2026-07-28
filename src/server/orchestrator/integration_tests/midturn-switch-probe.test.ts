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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMsg = any;

describe("PROBE: mid-turn reattach ordering", () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-midturn-"));
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
    } catch { /* ignore */ }
  });

  const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

  it("loses mid-turn content when a persist lands between the history read and the WS attach", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status
    const sessionId = client.sessionId;

    client.send({ type: "send_message", text: "Do the thing" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession("probe-session");
    await client.receiveType("session_started");

    // ---- turn produces group 1, persisted at its tool-result boundary ----
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

    // ---- user switches away ----
    client.close();
    await settle();

    // ---- user switches back: the browser fetches history FIRST (the WS is
    //      open but the server is still inside activateSession) ----
    const histRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/history`);
    const hist = await histRes.json() as { messages: AnyMsg[] };

    // ---- a tool-result boundary lands in that window: it persists the turn
    //      AND advances the replay cursor past everything buffered so far ----
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
    await settle();

    // ---- now the WS attaches and replays ----
    const back = await TestClient.connect(port, sessionId);
    const replayed: AnyMsg[] = [];
    try {
      for (let i = 0; i < 30; i++) replayed.push(await back.receive(300));
    } catch { /* drained */ }

    // What the client ends up rendering: HTTP history baseline + replayed tail.
    const historyText = hist.messages.map((m) => m.text).join(" | ");
    const replayText = replayed
      .filter((m) => m.type === "agent_event")
      .map((m) => JSON.stringify(m.event))
      .join(" | ");

    fs.writeFileSync(
      "/tmp/probe-out.txt",
      `HISTORY: ${historyText}\nREPLAY: ${replayText}\n`,
    );

    // GROUP-TWO is in neither → it vanishes from the transcript.
    expect(`${historyText} ${replayText}`).toContain("GROUP-TWO");
  });
});
