import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { ClaudeAdapter } from "./claude-adapter.js";
import type { ClaudeEvent } from "../../shared/types.js";

/** Minimal fake ClaudeProcess for testing the adapter in isolation. */
class FakeInnerProcess extends EventEmitter {
  runCalled = false;
  lastArgs: unknown[] = [];
  killed = false;
  stdinData: string[] = [];

  run(
    prompt: string,
    sessionId?: string,
    systemPrompt?: string,
    images?: unknown[],
    cwd?: string,
    permissionMode?: string,
  ) {
    this.runCalled = true;
    this.lastArgs = [prompt, sessionId, systemPrompt, images, cwd, permissionMode];
  }

  writeStdin(data: string) {
    this.stdinData.push(data);
  }

  kill() {
    this.killed = true;
  }
}

describe("ClaudeAdapter", () => {
  it("has agentId 'claude'", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);
    expect(adapter.agentId).toBe("claude");
  });

  it("reports Claude capabilities", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);
    expect(adapter.capabilities.supportsResume).toBe(true);
    expect(adapter.capabilities.supportsImages).toBe(true);
    expect(adapter.capabilities.supportsSystemPrompt).toBe(true);
    expect(adapter.capabilities.supportsPermissionModes).toBe(true);
    expect(adapter.capabilities.supportedPermissionModes).toContain("auto");
    expect(adapter.capabilities.toolNames).toContain("Write");
    expect(adapter.capabilities.toolNames).toContain("Bash");
  });

  it("maps system event to agent_init", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);

    const events: unknown[] = [];
    adapter.on("event", (e) => events.push(e));

    inner.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "sess-123",
      model: "claude-sonnet-4-20250514",
      tools: ["Write", "Read"],
    } satisfies ClaudeEvent);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "agent_init",
      agentId: "claude",
      sessionId: "sess-123",
      model: "claude-sonnet-4-20250514",
      tools: ["Write", "Read"],
    });
  });

  it("maps assistant event to agent_assistant", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);

    const events: unknown[] = [];
    adapter.on("event", (e) => events.push(e));

    inner.emit("event", {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Hello" },
          { type: "tool_use", id: "t1", name: "Write", input: { file_path: "a.ts" } },
        ],
      },
    } satisfies ClaudeEvent);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "agent_assistant",
      content: [
        { type: "text", text: "Hello" },
        { type: "tool_use", id: "t1", name: "Write", input: { file_path: "a.ts" } },
      ],
    });
  });

  it("maps user event to agent_tool_result", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);

    const events: unknown[] = [];
    adapter.on("event", (e) => events.push(e));

    const content = [{ type: "tool_result", tool_use_id: "t1", content: "ok" }];
    inner.emit("event", {
      type: "user",
      message: { content },
    } satisfies ClaudeEvent);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "agent_tool_result",
      content,
    });
  });

  it("maps result event to agent_result with cost and tokens", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);

    const events: unknown[] = [];
    adapter.on("event", (e) => events.push(e));

    inner.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "sess-123",
      total_cost_usd: 0.05,
      duration_ms: 1200,
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 10,
      cache_write_tokens: 5,
    } satisfies ClaudeEvent);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "agent_result",
      status: "success",
      sessionId: "sess-123",
      cost: { totalUsd: 0.05 },
      tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
      durationMs: 1200,
      error: undefined,
    });
  });

  it("maps error result with error message", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);

    const events: unknown[] = [];
    adapter.on("event", (e) => events.push(e));

    inner.emit("event", {
      type: "result",
      subtype: "error",
      session_id: "sess-123",
      result: "Something went wrong",
    } satisfies ClaudeEvent);

    expect(events).toHaveLength(1);
    expect((events[0] as any).type).toBe("agent_result");
    expect((events[0] as any).status).toBe("error");
    expect((events[0] as any).error).toBe("Something went wrong");
  });

  it("forwards done event", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);

    const codes: number[] = [];
    adapter.on("done", (c) => codes.push(c));

    inner.emit("done", 0);
    expect(codes).toEqual([0]);
  });

  it("forwards error event", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);

    const errors: Error[] = [];
    adapter.on("error", (e) => errors.push(e));

    inner.emit("error", new Error("test error"));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("test error");
  });

  it("forwards auth_required event", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);

    let authRequired = false;
    adapter.on("auth_required", () => { authRequired = true; });

    inner.emit("auth_required");
    expect(authRequired).toBe(true);
  });

  it("forwards log event", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);

    const logs: [string, string][] = [];
    adapter.on("log", (source, text) => logs.push([source, text]));

    inner.emit("log", "stderr", "debug info");
    expect(logs).toEqual([["stderr", "debug info"]]);
  });

  it("delegates run() to inner process with positional args", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);

    adapter.run({
      prompt: "Hello",
      sessionId: "sess-1",
      systemPrompt: "Be helpful",
      images: [{ data: "abc", mediaType: "image/png" }],
      cwd: "/workspace",
      permissionMode: "auto",
    });

    expect(inner.runCalled).toBe(true);
    expect(inner.lastArgs[0]).toBe("Hello");
    expect(inner.lastArgs[1]).toBe("sess-1");
    expect(inner.lastArgs[2]).toBe("Be helpful");
    expect(inner.lastArgs[3]).toEqual([{ data: "abc", mediaType: "image/png" }]);
    expect(inner.lastArgs[4]).toBe("/workspace");
    expect(inner.lastArgs[5]).toBe("auto");
  });

  it("delegates writeStdin() to inner process", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);

    adapter.writeStdin("user input\n");
    expect(inner.stdinData).toEqual(["user input\n"]);
  });

  it("delegates kill() to inner process", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);

    adapter.kill();
    expect(inner.killed).toBe(true);
  });
});
