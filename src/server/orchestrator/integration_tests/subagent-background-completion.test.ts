// CLI 2.1.219 fixtures; wire trace: ../subagent-completion.ts.

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
import { isBackgroundLaunchAck, parseSubagentReport, parseReportMeta } from "../../shared/subagent-report.js";
import type { ToolResultEntry } from "../session-runner.js";

const TOOL_ID = "toolu_013fUMwLfWGNwaaqVsj8ojXF";

const ACK_TEXT = [
  "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)",
  "agentId: af0615944a51b4583 (internal ID - do not mention to user. Use SendMessage with to: 'af0615944a51b4583', summary: '<5-10 word recap>' to continue this agent.)",
  "The agent is working in the background. You will be notified automatically when it completes.",
  "output_file: /tmp/claude-1000/-tmp-probe/3bc49c90/tasks/af0615944a51b4583.output",
].join("\n");

const REPORT = "## Probe report\n\nThe number seven holds profound significance.";

describe("Integration: a finished background subagent's card", () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-bgsubagent-"));
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

  function launchBackgroundSubagent() {
    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Launched a subagent." },
          {
            type: "tool_use",
            id: TOOL_ID,
            name: "Agent",
            input: { description: "Report on the number seven", subagent_type: "general-purpose" },
          },
        ],
      },
    });
    lastClaude.emit("event", {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: TOOL_ID, content: [{ type: "text", text: ACK_TEXT }] }],
      },
    });
  }

  async function storedResult(sessionId: string): Promise<ToolResultEntry | undefined> {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/history`);
    const body = await res.json() as { messages: { toolResults?: ToolResultEntry[] }[] };
    for (const msg of body.messages) {
      const found = msg.toolResults?.find((r) => r.toolUseId === TOOL_ID);
      if (found) return found;
    }
    return undefined;
  }

  it("retires mid-turn, and the retirement survives the next tool-result boundary", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = client.sessionId;

    client.send({ type: "send_message", text: "Look into the number seven" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession("bg-subagent-1");
    await client.receiveType("session_started");

    launchBackgroundSubagent();
    await settle();
    expect(isBackgroundLaunchAck(parseSubagentReport((await storedResult(sessionId))!.content).text)).toBe(true);

    lastClaude.emit("event", {
      type: "agent_self_wake",
      taskId: "af0615944a51b4583",
      toolUseId: TOOL_ID,
      status: "completed",
      summary: REPORT,
      usage: { totalTokens: 10408, toolUses: 0, durationMs: 2757 },
    });
    await settle();

    const update = await client.receiveType("subagent_report_update");
    expect(update).toMatchObject({ sessionId, toolUseId: TOOL_ID });

    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Reading the notes." },
          { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/notes.txt" } },
        ],
      },
    });
    lastClaude.emit("event", {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] },
    });
    lastClaude.finish("bg-subagent-1");
    await settle(250);

    const stored = await storedResult(sessionId);
    const parsed = parseSubagentReport(stored!.content);
    expect(isBackgroundLaunchAck(parsed.text)).toBe(false);
    expect(parsed.text).toBe(REPORT);
    expect(parseReportMeta(parsed.meta)).toEqual({ tokens: 10408, toolUses: 0, durationMs: 2757 });
    client.close();
  });

  it("retires a card whose turn already finished, and it stays retired on reload", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = client.sessionId;

    client.send({ type: "send_message", text: "Look into the number seven" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession("bg-subagent-2");
    await client.receiveType("session_started");

    launchBackgroundSubagent();
    lastClaude.finish("bg-subagent-2");
    await settle(250);

    lastClaude.emit("event", {
      type: "agent_self_wake",
      taskId: "af0615944a51b4583",
      toolUseId: TOOL_ID,
      status: "completed",
      summary: REPORT,
    });
    await settle();

    expect(parseSubagentReport((await storedResult(sessionId))!.content).text).toBe(REPORT);
    client.close();
  });

  it("marks a failed background subagent's result as an error", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = client.sessionId;

    client.send({ type: "send_message", text: "Look into the number seven" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession("bg-subagent-3");
    await client.receiveType("session_started");

    launchBackgroundSubagent();
    lastClaude.finish("bg-subagent-3");
    await settle(250);

    lastClaude.emit("event", {
      type: "agent_self_wake",
      taskId: "af0615944a51b4583",
      toolUseId: TOOL_ID,
      status: "failed",
      summary: "Agent stalled: no progress for 300s",
    });
    await settle();

    const stored = await storedResult(sessionId);
    expect(stored!.isError).toBe(true);
    expect(stored!.content).toContain("Agent stalled");
    client.close();
  });

  it("leaves a background Bash command's result untouched", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = client.sessionId;

    client.send({ type: "send_message", text: "Run the suite in the background" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession("bg-bash");
    await client.receiveType("session_started");

    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Running." },
          { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "npm test", run_in_background: true } },
        ],
      },
    });
    lastClaude.emit("event", {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "bash-1", content: "Command running in background" }] },
    });
    lastClaude.finish("bg-bash");
    await settle(250);

    lastClaude.emit("event", {
      type: "agent_self_wake",
      taskId: "bg-1",
      toolUseId: "bash-1",
      status: "completed",
      summary: 'Background command "npm test" completed (exit code 0)',
    });
    await settle();

    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/history`);
    const body = await res.json() as { messages: { toolResults?: ToolResultEntry[] }[] };
    const bash = body.messages.flatMap((m) => m.toolResults ?? []).find((r) => r.toolUseId === "bash-1");
    expect(bash!.content).toBe("Command running in background");
    client.close();
  });
});
