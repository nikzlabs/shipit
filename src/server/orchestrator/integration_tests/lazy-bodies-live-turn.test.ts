import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

const HEAVY = Array.from({ length: 5_000 }, (_, i) => `stdout line ${i}`).join("\n");
const FILE_BODY = Array.from({ length: 500 }, (_, i) => `const x${i} = ${i};`).join("\n");

describe("Integration: lazy bodies on a live turn (planning#269)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let lastClaude: FakeClaudeProcess = null as unknown as FakeClaudeProcess;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as unknown as FakeClaudeProcess;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lazy-live-"));
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
        return lastClaude as unknown as never;
      },
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore */ }
  });

  async function runTurnWithToolResult(): Promise<{
    client: TestClient;
    sessionId: string;
    events: Record<string, unknown>[];
  }> {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "run the tests" });
    await waitForClaude(() => lastClaude);

    lastClaude.emit("event", { type: "system", subtype: "init", session_id: "live-lazy-session" });
    const started = await client.receiveType("session_started");
    const sessionId = (started as unknown as { session: { id: string } }).session.id;

    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "bash-live", name: "Bash", input: { command: "npm test" } },
          { type: "tool_use", id: "write-live", name: "Write", input: { file_path: "/a.ts", content: FILE_BODY } },
        ],
      },
    });

    lastClaude.emit("event", {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "bash-live", content: HEAVY },
          { type: "tool_result", tool_use_id: "write-live", content: "ok" },
        ],
      },
    });

    const events = (await client.drain())
      .filter((m) => m.type === "agent_event")
      .map((m) => (m as unknown as { event: Record<string, unknown> }).event);
    expect(events.some((e) => e.type === "agent_tool_result"), "no agent_tool_result reached the client").toBe(true);
    return { client, sessionId, events };
  }

  const toolResultBlocks = (events: Record<string, unknown>[]): Record<string, unknown>[] =>
    events
      .filter((e) => e.type === "agent_tool_result")
      .flatMap((e) => (e.content as Record<string, unknown>[] | undefined) ?? [])
      .filter((b) => b.type === "tool_result");

  it("strips the body from the LIVE emit, not just from history", async () => {
    const { client, events } = await runTurnWithToolResult();
    const bash = toolResultBlocks(events).find((b) => b.tool_use_id === "bash-live")!;

    expect(bash.content).toBe("");
    expect(bash.shipit_truncated).toBe(true);
    expect(bash.shipit_total_lines).toBe(5_000);
    client.close();
  });

  it("the row is already committed when that frame arrives — the fetch cannot 404", async () => {
    const { client, sessionId } = await runTurnWithToolResult();

    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/tool-results/bash-live` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { content: string }).content).toBe(HEAVY);
    client.close();
  });

  it("does NOT strip an Edit/Write input on the live path — its row isn't committed yet", async () => {
    const { client, sessionId, events } = await runTurnWithToolResult();

    const assistant = events.find((e) => e.type === "agent_assistant");
    const toolUse = ((assistant?.content ?? []) as Record<string, unknown>[])
      .find((b) => b.type === "tool_use" && b.name === "Write");

    expect(toolUse).toBeDefined();
    expect(toolUse!.bodyTruncated).toBeUndefined();
    expect((toolUse!.input as Record<string, unknown>).content).toBe(FILE_BODY);

    const history = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    const messages = (history.json() as { messages: { toolUse?: { id: string; bodyTruncated?: true }[] }[] }).messages;
    const persisted = messages.flatMap((m) => m.toolUse ?? []).find((t) => t.id === "write-live");
    expect(persisted?.bodyTruncated).toBe(true);
    client.close();
  });

  it("a mid-turn reconnect no longer re-sends the bodies a boundary already committed (planning#299)", async () => {
    const { client, sessionId } = await runTurnWithToolResult();
    client.close();
    await new Promise((r) => setTimeout(r, 100));

    const back = await TestClient.connect(port, sessionId);
    const replayed: Record<string, unknown>[] = [];
    try {
      for (let i = 0; i < 40; i++) replayed.push(await back.receive(300) as unknown as Record<string, unknown>);
    } catch { /* drained */ }

    const snapshot = replayed.find((m) => m.type === "turn_snapshot") as unknown as {
      messages: { toolUse?: { id: string; input: Record<string, unknown>; bodyTruncated?: true }[] }[];
    };
    expect(snapshot).toBeDefined();

    const write = snapshot.messages.flatMap((m) => m.toolUse ?? []).find((t) => t.id === "write-live")!;
    expect(write.bodyTruncated).toBe(true);
    expect(write.input.content).toBeUndefined();

    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/tool-inputs/write-live` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { input: { content: string } }).input.content).toBe(FILE_BODY);
    back.close();
  });

  it("persists the whole body even though the wire copy was emptied", async () => {
    const { client, sessionId } = await runTurnWithToolResult();

    const stored = chatHistoryManager.load(sessionId) as { toolResults?: { toolUseId: string; content: string }[] }[];
    const bash = stored.flatMap((m) => m.toolResults ?? []).find((r) => r.toolUseId === "bash-live");
    expect(bash?.content).toBe(HEAVY);
    client.close();
  });
});
