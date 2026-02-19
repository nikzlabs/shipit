import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { CodexAdapter } from "./codex-adapter.js";
import type { CodexEvent } from "./codex-process.js";
import type { AgentEvent } from "./agent-process.js";

/** Minimal fake CodexProcess for testing the adapter in isolation. */
class FakeCodexProcess extends EventEmitter {
  runCalled = false;
  lastArgs: unknown[] = [];
  killed = false;
  stdinData: string[] = [];

  run(
    prompt: string,
    approvalMode?: string,
    model?: string,
    cwd?: string,
  ) {
    this.runCalled = true;
    this.lastArgs = [prompt, approvalMode, model, cwd];
  }

  writeStdin(data: string) {
    this.stdinData.push(data);
  }

  kill() {
    this.killed = true;
  }
}

describe("CodexAdapter", () => {
  let inner: FakeCodexProcess;
  let adapter: CodexAdapter;
  let events: AgentEvent[];

  beforeEach(() => {
    inner = new FakeCodexProcess();
    adapter = new CodexAdapter(inner as any);
    events = [];
    adapter.on("event", (e) => events.push(e));
  });

  it("has agentId 'codex'", () => {
    expect(adapter.agentId).toBe("codex");
  });

  it("reports Codex capabilities", () => {
    expect(adapter.capabilities.supportsResume).toBe(false);
    expect(adapter.capabilities.supportsImages).toBe(false);
    expect(adapter.capabilities.supportsSystemPrompt).toBe(false);
    expect(adapter.capabilities.supportsPermissionModes).toBe(true);
    expect(adapter.capabilities.supportedPermissionModes).toContain("auto");
    expect(adapter.capabilities.toolNames).toContain("shell");
    expect(adapter.capabilities.toolNames).toContain("file_write");
    expect(adapter.capabilities.toolNames).toContain("file_read");
    expect(adapter.capabilities.models).toContain("o4-mini");
  });

  // ---- Event mapping tests ----

  it("maps thread.started to agent_init", () => {
    inner.emit("event", {
      type: "thread.started",
      thread_id: "thread-abc-123",
    } satisfies CodexEvent);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "agent_init",
      agentId: "codex",
      sessionId: "thread-abc-123",
      tools: adapter.capabilities.toolNames,
    });
  });

  it("maps turn.started to null (no AgentEvent emitted)", () => {
    inner.emit("event", {
      type: "turn.started",
    } satisfies CodexEvent);

    expect(events).toHaveLength(0);
  });

  it("maps turn.completed to agent_result with success", () => {
    // Start a thread first so sessionId is set
    inner.emit("event", { type: "thread.started", thread_id: "t-1" } satisfies CodexEvent);
    // Start turn so timing is tracked
    inner.emit("event", { type: "turn.started" } satisfies CodexEvent);
    events.length = 0; // clear the init event

    inner.emit("event", {
      type: "turn.completed",
      usage: {
        input_tokens: 500,
        cached_input_tokens: 100,
        output_tokens: 200,
      },
    } satisfies CodexEvent);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "agent_result",
      status: "success",
      sessionId: "t-1",
      tokens: {
        input: 500,
        output: 200,
        cacheRead: 100,
      },
    });
    expect((events[0] as any).durationMs).toBeGreaterThanOrEqual(0);
  });

  it("maps turn.completed without usage", () => {
    inner.emit("event", { type: "thread.started", thread_id: "t-2" } satisfies CodexEvent);
    events.length = 0;

    inner.emit("event", {
      type: "turn.completed",
    } satisfies CodexEvent);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "agent_result",
      status: "success",
      sessionId: "t-2",
      tokens: undefined,
    });
  });

  it("maps turn.failed to agent_result with error", () => {
    inner.emit("event", { type: "thread.started", thread_id: "t-3" } satisfies CodexEvent);
    events.length = 0;

    inner.emit("event", {
      type: "turn.failed",
      error: { message: "Rate limit exceeded" },
    } satisfies CodexEvent);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "agent_result",
      status: "error",
      sessionId: "t-3",
      error: "Rate limit exceeded",
    });
  });

  it("maps turn.failed without error message", () => {
    inner.emit("event", { type: "thread.started", thread_id: "t-4" } satisfies CodexEvent);
    events.length = 0;

    inner.emit("event", {
      type: "turn.failed",
    } satisfies CodexEvent);

    expect(events).toHaveLength(1);
    expect((events[0] as any).error).toBe("Turn failed");
  });

  // ---- Item event tests ----

  it("maps agent_message item to agent_assistant with text", () => {
    inner.emit("event", {
      type: "item.completed",
      item: {
        id: "msg-1",
        type: "agent_message",
        text: "Hello, I can help with that!",
      },
    } satisfies CodexEvent);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "agent_assistant",
      content: [{ type: "text", text: "Hello, I can help with that!" }],
    });
  });

  it("skips agent_message item without text", () => {
    inner.emit("event", {
      type: "item.completed",
      item: {
        id: "msg-2",
        type: "agent_message",
      },
    } satisfies CodexEvent);

    expect(events).toHaveLength(0);
  });

  it("maps command_execution item.started to agent_assistant with tool_use", () => {
    inner.emit("event", {
      type: "item.started",
      item: {
        id: "cmd-1",
        type: "command_execution",
        command: "npm test",
        status: "in_progress",
      },
    } satisfies CodexEvent);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "agent_assistant",
      content: [{
        type: "tool_use",
        id: "cmd-1",
        name: "shell",
        input: {
          command: "npm test",
          status: "in_progress",
        },
      }],
    });
  });

  it("maps command_execution item.completed to agent_tool_result", () => {
    inner.emit("event", {
      type: "item.completed",
      item: {
        id: "cmd-2",
        type: "command_execution",
        command: "ls -la",
        aggregated_output: "total 42\ndrwxr-xr-x ...",
        exit_code: 0,
        status: "completed",
      },
    } satisfies CodexEvent);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "agent_tool_result",
      content: [{
        type: "tool_result",
        tool_use_id: "cmd-2",
        content: "total 42\ndrwxr-xr-x ...",
      }],
    });
  });

  it("maps file_change item to agent_assistant with tool_use blocks", () => {
    inner.emit("event", {
      type: "item.completed",
      item: {
        id: "fc-1",
        type: "file_change",
        changes: [
          { path: "src/index.ts", kind: "update" },
          { path: "src/new-file.ts", kind: "add" },
          { path: "src/old.ts", kind: "delete" },
        ],
        status: "completed",
      },
    } satisfies CodexEvent);

    expect(events).toHaveLength(1);
    const ev = events[0] as any;
    expect(ev.type).toBe("agent_assistant");
    expect(ev.content).toHaveLength(3);
    expect(ev.content[0]).toEqual({
      type: "tool_use",
      id: "fc-1-0",
      name: "file_edit",
      input: { file_path: "src/index.ts", kind: "update", status: "completed" },
    });
    expect(ev.content[1]).toEqual({
      type: "tool_use",
      id: "fc-1-1",
      name: "file_write",
      input: { file_path: "src/new-file.ts", kind: "add", status: "completed" },
    });
    expect(ev.content[2]).toEqual({
      type: "tool_use",
      id: "fc-1-2",
      name: "file_write",
      input: { file_path: "src/old.ts", kind: "delete", status: "completed" },
    });
  });

  it("skips file_change item with no changes", () => {
    inner.emit("event", {
      type: "item.completed",
      item: {
        id: "fc-2",
        type: "file_change",
        changes: [],
      },
    } satisfies CodexEvent);

    expect(events).toHaveLength(0);
  });

  it("maps web_search item to agent_assistant with tool_use", () => {
    inner.emit("event", {
      type: "item.completed",
      item: {
        id: "ws-1",
        type: "web_search",
      },
    } satisfies CodexEvent);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "agent_assistant",
      content: [{
        type: "tool_use",
        id: "ws-1",
        name: "web_search",
        input: {},
      }],
    });
  });

  it("maps reasoning item to agent_assistant text", () => {
    inner.emit("event", {
      type: "item.completed",
      item: {
        id: "reason-1",
        type: "reasoning",
        text: "Let me think about this...",
      },
    } satisfies CodexEvent);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "agent_assistant",
      content: [{ type: "text", text: "Let me think about this..." }],
    });
  });

  it("skips reasoning item without text", () => {
    inner.emit("event", {
      type: "item.completed",
      item: {
        id: "reason-2",
        type: "reasoning",
      },
    } satisfies CodexEvent);

    expect(events).toHaveLength(0);
  });

  it("maps mcp_tool_call item to agent_assistant with tool_use", () => {
    inner.emit("event", {
      type: "item.started",
      item: {
        id: "mcp-1",
        type: "mcp_tool_call",
        server: "my-server",
        tool: "custom_tool",
        status: "in_progress",
      },
    } satisfies CodexEvent);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "agent_assistant",
      content: [{
        type: "tool_use",
        id: "mcp-1",
        name: "custom_tool",
        input: { server: "my-server", status: "in_progress" },
      }],
    });
  });

  it("skips todo_list and error item types", () => {
    inner.emit("event", {
      type: "item.completed",
      item: { id: "td-1", type: "todo_list" },
    } satisfies CodexEvent);

    inner.emit("event", {
      type: "item.completed",
      item: { id: "err-1", type: "error" },
    } satisfies CodexEvent);

    expect(events).toHaveLength(0);
  });

  // ---- Error event tests ----

  it("maps top-level error to agent_result error", () => {
    inner.emit("event", { type: "thread.started", thread_id: "t-5" } satisfies CodexEvent);
    events.length = 0;

    inner.emit("event", {
      type: "error",
      message: "API error: 500 Internal Server Error",
    } satisfies CodexEvent);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "agent_result",
      status: "error",
      sessionId: "t-5",
      error: "API error: 500 Internal Server Error",
    });
  });

  it("treats reconnect errors as log messages (no event emitted)", () => {
    const logs: [string, string][] = [];
    adapter.on("log", (source, text) => logs.push([source, text]));

    inner.emit("event", {
      type: "error",
      message: "Reconnecting... 1/5",
    } satisfies CodexEvent);

    expect(events).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0][1]).toContain("Reconnecting");
  });

  // ---- Delegation tests ----

  it("forwards done event", () => {
    const codes: number[] = [];
    adapter.on("done", (c) => codes.push(c));

    inner.emit("done", 0);
    expect(codes).toEqual([0]);
  });

  it("forwards error event", () => {
    const errors: Error[] = [];
    adapter.on("error", (e) => errors.push(e));

    inner.emit("error", new Error("spawn failed"));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("spawn failed");
  });

  it("forwards auth_required event", () => {
    let authRequired = false;
    adapter.on("auth_required", () => { authRequired = true; });

    inner.emit("auth_required");
    expect(authRequired).toBe(true);
  });

  it("forwards log event", () => {
    const logs: [string, string][] = [];
    adapter.on("log", (source, text) => logs.push([source, text]));

    inner.emit("log", "stderr", "debug output");
    expect(logs).toEqual([["stderr", "debug output"]]);
  });

  it("delegates run() with auto permission mode → full-auto", () => {
    adapter.run({
      prompt: "Fix the tests",
      cwd: "/workspace",
      permissionMode: "auto",
    });

    expect(inner.runCalled).toBe(true);
    expect(inner.lastArgs[0]).toBe("Fix the tests");
    expect(inner.lastArgs[1]).toBe("full-auto");
    expect(inner.lastArgs[3]).toBe("/workspace");
  });

  it("delegates run() with plan permission mode → suggest", () => {
    adapter.run({
      prompt: "Review this code",
      permissionMode: "plan",
    });

    expect(inner.lastArgs[1]).toBe("suggest");
  });

  it("delegates run() with normal permission mode → auto-edit", () => {
    adapter.run({
      prompt: "Refactor the module",
      permissionMode: "normal",
    });

    expect(inner.lastArgs[1]).toBe("auto-edit");
  });

  it("delegates run() with no permission mode → full-auto", () => {
    adapter.run({ prompt: "Hello" });
    expect(inner.lastArgs[1]).toBe("full-auto");
  });

  it("delegates writeStdin() to inner process", () => {
    adapter.writeStdin("user input\n");
    expect(inner.stdinData).toEqual(["user input\n"]);
  });

  it("delegates kill() to inner process", () => {
    adapter.kill();
    expect(inner.killed).toBe(true);
  });

  // ---- Full conversation flow test ----

  it("handles a complete conversation flow", () => {
    // 1. Thread starts
    inner.emit("event", { type: "thread.started", thread_id: "conv-1" } satisfies CodexEvent);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "agent_init", agentId: "codex", sessionId: "conv-1" });

    // 2. Turn starts
    inner.emit("event", { type: "turn.started" } satisfies CodexEvent);
    expect(events).toHaveLength(1); // no new event

    // 3. Agent produces a message
    inner.emit("event", {
      type: "item.completed",
      item: { id: "m1", type: "agent_message", text: "I'll run the tests for you." },
    } satisfies CodexEvent);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: "agent_assistant",
      content: [{ type: "text", text: "I'll run the tests for you." }],
    });

    // 4. Agent runs a command
    inner.emit("event", {
      type: "item.started",
      item: { id: "c1", type: "command_execution", command: "npm test", status: "in_progress" },
    } satisfies CodexEvent);
    expect(events).toHaveLength(3);
    expect(events[2]).toMatchObject({
      type: "agent_assistant",
      content: [{ type: "tool_use", id: "c1", name: "shell" }],
    });

    // 5. Command completes
    inner.emit("event", {
      type: "item.completed",
      item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "All tests passed", exit_code: 0, status: "completed" },
    } satisfies CodexEvent);
    expect(events).toHaveLength(4);
    expect(events[3]).toMatchObject({
      type: "agent_tool_result",
      content: [{ type: "tool_result", tool_use_id: "c1", content: "All tests passed" }],
    });

    // 6. Turn completes
    inner.emit("event", {
      type: "turn.completed",
      usage: { input_tokens: 1000, output_tokens: 300 },
    } satisfies CodexEvent);
    expect(events).toHaveLength(5);
    expect(events[4]).toMatchObject({
      type: "agent_result",
      status: "success",
      sessionId: "conv-1",
      tokens: { input: 1000, output: 300 },
    });
  });
});
