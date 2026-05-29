/**
 * Integration tests for subagent transparency (109).
 *
 * These exercise the full path from FakeClaude → orchestrator → WS client →
 * persisted chat history. The Claude CLI emits subagent events with a
 * top-level `parent_tool_use_id`, which the orchestrator preserves on the
 * outgoing AgentEvent so the client can render the subagent's prompt, work,
 * and final report under the parent Task tool.
 */

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
import { DatabaseManager } from "../../shared/database.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

describe("Integration: Subagent transparency (109)", () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-subagent-"));

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
      // ignore — OS will clean up
    }
  });

  it("forwards parentToolUseId on nested subagent events to the WS client", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Audit the review feature" });
    await waitForClaude(() => lastClaude);

    lastClaude.emit("event", { type: "system", subtype: "init", session_id: "subagent-session-1" });
    await client.receiveType("session_started");

    // Parent assistant message with a Task tool call
    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "I'll dispatch a subagent." },
          {
            type: "tool_use",
            id: "task-1",
            name: "Task",
            input: { description: "Audit review", prompt: "Walk through the review feature." },
          },
        ],
      },
    });
    const parentEvent = await client.receiveType("agent_event");
    expect((parentEvent as { event: { type: string } }).event.type).toBe("agent_assistant");

    // Nested subagent assistant event — carries parent_tool_use_id
    lastClaude.emit("event", {
      type: "assistant",
      parent_tool_use_id: "task-1",
      message: {
        content: [
          { type: "text", text: "Reading the review file..." },
          { type: "tool_use", id: "sub-r1", name: "Read", input: { file_path: "/review.ts" } },
        ],
      },
    });
    const nestedEvent = await client.receiveType("agent_event");
    const ne = (nestedEvent as { event: { type: string; parentToolUseId?: string } }).event;
    expect(ne.type).toBe("agent_assistant");
    expect(ne.parentToolUseId).toBe("task-1");

    // Nested tool_result also gets the parent id
    lastClaude.emit("event", {
      type: "user",
      parent_tool_use_id: "task-1",
      message: {
        content: [{ type: "tool_result", tool_use_id: "sub-r1", content: "file contents" }],
      },
    });
    const nestedResult = await client.receiveType("agent_event");
    const nr = (nestedResult as { event: { type: string; parentToolUseId?: string } }).event;
    expect(nr.type).toBe("agent_tool_result");
    expect(nr.parentToolUseId).toBe("task-1");

    client.close();
  });

  it("persists subagent events on the parent message in chat history", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Spawn a subagent" });
    await waitForClaude(() => lastClaude);

    lastClaude.emit("event", { type: "system", subtype: "init", session_id: "subagent-session-2" });
    const sessionStarted = await client.receiveType("session_started");
    const appSessionId = (sessionStarted as { session: { id: string } }).session.id;

    // Parent: Task tool call
    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Dispatching..." },
          {
            type: "tool_use",
            id: "task-1",
            name: "Task",
            input: { description: "Audit", prompt: "Audit the codebase." },
          },
        ],
      },
    });

    // Nested subagent steps
    lastClaude.emit("event", {
      type: "assistant",
      parent_tool_use_id: "task-1",
      message: {
        content: [
          { type: "text", text: "Reading..." },
          { type: "tool_use", id: "sub-r1", name: "Read", input: { file_path: "/a.ts" } },
        ],
      },
    });
    lastClaude.emit("event", {
      type: "user",
      parent_tool_use_id: "task-1",
      message: {
        content: [{ type: "tool_result", tool_use_id: "sub-r1", content: "contents of a" }],
      },
    });
    lastClaude.emit("event", {
      type: "assistant",
      parent_tool_use_id: "task-1",
      message: {
        content: [{ type: "text", text: "Done auditing." }],
      },
    });

    // Parent receives the Task tool's final result
    lastClaude.emit("event", {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "task-1", content: "## Audit Report\n\nAll clean." }],
      },
    });

    // Parent finalizes
    lastClaude.finish("subagent-session-2");
    try { for (let i = 0; i < 20; i++) await client.receive(300); } catch { /* drain */ }

    // The persisted message should have:
    //   - toolUse: [Task tool]
    //   - toolResults: [the Task tool's final result]
    //   - subagentEvents: [3 entries — assistant, tool_result, assistant]
    const messages = chatHistoryManager.load(appSessionId);
    const assistantMsg = messages.find((m) => m.role === "assistant" && m.toolUse?.some((t) => t.name === "Task"));
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.toolUse).toHaveLength(1);
    expect(assistantMsg!.toolUse![0].name).toBe("Task");
    expect(assistantMsg!.toolResults).toBeDefined();
    expect(assistantMsg!.toolResults![0].toolUseId).toBe("task-1");
    expect(assistantMsg!.toolResults![0].content).toContain("Audit Report");

    // Subagent events were preserved with parent ids and split between assistant
    // and tool_result kinds.
    expect(assistantMsg!.subagentEvents).toBeDefined();
    expect(assistantMsg!.subagentEvents).toHaveLength(3);
    expect(assistantMsg!.subagentEvents![0].kind).toBe("assistant");
    expect(assistantMsg!.subagentEvents![0].parentToolUseId).toBe("task-1");
    expect(assistantMsg!.subagentEvents![1].kind).toBe("tool_result");
    expect(assistantMsg!.subagentEvents![1].parentToolUseId).toBe("task-1");
    expect(assistantMsg!.subagentEvents![2].kind).toBe("assistant");

    client.close();
  });

  it("does not pollute the main message stream with nested subagent tool calls", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Spawn subagent" });
    await waitForClaude(() => lastClaude);

    lastClaude.emit("event", { type: "system", subtype: "init", session_id: "subagent-session-3" });
    const sessionStarted = await client.receiveType("session_started");
    const appSessionId = (sessionStarted as { session: { id: string } }).session.id;

    // Parent message: a Task tool call
    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "task-1", name: "Task", input: { description: "Audit", prompt: "..." } },
        ],
      },
    });

    // Subagent does its own Bash call — this MUST NOT end up in the parent
    // message's toolUse list, otherwise the user sees nested actions floating
    // outside their Task call.
    lastClaude.emit("event", {
      type: "assistant",
      parent_tool_use_id: "task-1",
      message: {
        content: [
          { type: "tool_use", id: "sub-bash", name: "Bash", input: { command: "ls" } },
        ],
      },
    });
    lastClaude.emit("event", {
      type: "user",
      parent_tool_use_id: "task-1",
      message: {
        content: [{ type: "tool_result", tool_use_id: "sub-bash", content: "file1\nfile2" }],
      },
    });

    lastClaude.emit("event", {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "task-1", content: "report" }],
      },
    });
    lastClaude.finish("subagent-session-3");
    try { for (let i = 0; i < 20; i++) await client.receive(300); } catch { /* drain */ }

    const messages = chatHistoryManager.load(appSessionId);
    const assistantMsg = messages.find((m) => m.role === "assistant" && m.toolUse?.some((t) => t.name === "Task"));
    expect(assistantMsg).toBeDefined();
    // The parent's toolUse should ONLY contain the Task tool — never the
    // subagent's Bash. The subagent's Bash should live in subagentEvents.
    expect(assistantMsg!.toolUse).toHaveLength(1);
    expect(assistantMsg!.toolUse![0].name).toBe("Task");
    // The Bash lives in subagentEvents.
    const subBashStep = assistantMsg!.subagentEvents?.find(
      (e) => e.kind === "assistant" && e.toolUse.some((t) => t.name === "Bash"),
    );
    expect(subBashStep).toBeDefined();
    // The parent's toolResults should ONLY contain the Task's result, not the
    // subagent's Bash result.
    expect(assistantMsg!.toolResults).toHaveLength(1);
    expect(assistantMsg!.toolResults![0].toolUseId).toBe("task-1");

    client.close();
  });

  it("separates multiple text blocks in a single subagent assistant event with paragraph breaks", async () => {
    // Regression: an `assistant` event whose content is
    //   [text "A.", tool_use, text "B.", tool_use, text "C."]
    // used to render as "A.B.C." (joined with ""), losing the boundaries
    // between distinct preambles. Each text block is its own narration and
    // must stay separated so `whitespace-pre-wrap` renders them as paragraphs.
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Spawn a chatty subagent" });
    await waitForClaude(() => lastClaude);

    lastClaude.emit("event", { type: "system", subtype: "init", session_id: "subagent-session-4" });
    const sessionStarted = await client.receiveType("session_started");
    const appSessionId = (sessionStarted as { session: { id: string } }).session.id;

    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "task-1", name: "Task", input: { description: "Multi", prompt: "..." } },
        ],
      },
    });

    // Subagent emits a single assistant event with three text blocks
    // separated by tool_use blocks — the shape that interleaved-thinking
    // serial tool calls produce in one turn.
    lastClaude.emit("event", {
      type: "assistant",
      parent_tool_use_id: "task-1",
      message: {
        content: [
          { type: "text", text: "Now let me look at file A." },
          { type: "tool_use", id: "sub-r1", name: "Read", input: { file_path: "/a.ts" } },
          { type: "text", text: "Now let me look at file B." },
          { type: "tool_use", id: "sub-r2", name: "Read", input: { file_path: "/b.ts" } },
          { type: "text", text: "Let me verify by listing scripts." },
          { type: "tool_use", id: "sub-bash", name: "Bash", input: { command: "ls" } },
        ],
      },
    });

    lastClaude.emit("event", {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "task-1", content: "report" }],
      },
    });
    lastClaude.finish("subagent-session-4");
    try { for (let i = 0; i < 20; i++) await client.receive(300); } catch { /* drain */ }

    const messages = chatHistoryManager.load(appSessionId);
    const assistantMsg = messages.find((m) => m.role === "assistant" && m.toolUse?.some((t) => t.name === "Task"));
    expect(assistantMsg).toBeDefined();
    const subStep = assistantMsg!.subagentEvents?.find((e) => e.kind === "assistant");
    expect(subStep).toBeDefined();
    if (subStep?.kind !== "assistant") throw new Error("expected assistant step");
    // Critical: the three preambles must stay separated, not run together.
    expect(subStep.text).not.toContain("file A.Now let me");
    expect(subStep.text).toContain("Now let me look at file A.");
    expect(subStep.text).toContain("Now let me look at file B.");
    expect(subStep.text).toContain("Let me verify by listing scripts.");
    expect(subStep.text).toMatch(/file A\.\n\nNow let me look at file B/);

    client.close();
  });
});
