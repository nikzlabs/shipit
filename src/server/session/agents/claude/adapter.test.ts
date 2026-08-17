import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { ClaudeAdapter, mapCliMcpStatus } from "./adapter.js";
import type { ClaudeEvent } from "../../../shared/types.js";
import type { McpServerStatus } from "../../../shared/types/mcp-types.js";
import type { AgentRunParams } from "../agent-process.js";

/** Minimal fake ClaudeProcess for testing the adapter in isolation. */
class FakeInnerProcess extends EventEmitter {
  runCalled = false;
  killed = false;
  stdinData: string[] = [];

  run(opts: Record<string, unknown>) {
    this.runCalled = true;
    this.lastRunOpts = opts;
  }
  lastRunOpts: Record<string, unknown> = {};

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
    expect(adapter.capabilities.supportedPermissionModes).toContain("plan");
    // docs/138 — the classifier-gated guarded mode is advertised.
    expect(adapter.capabilities.supportedPermissionModes).toContain("guarded");
    expect(adapter.capabilities.toolNames).toContain("Write");
    expect(adapter.capabilities.toolNames).toContain("Bash");
    // 125 — chat-native AI review needs both subagent + MCP support, both
    // of which Claude Code provides. The flag drives the file-preview
    // modal's "Ask agent to review" affordance.
    expect(adapter.capabilities.supportsReview).toBe(true);
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

  it("maps the init event's permissionMode to agent_init (docs/138)", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);

    const events: unknown[] = [];
    adapter.on("event", (e) => events.push(e));

    inner.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "sess-guarded",
      permissionMode: "auto",
    } satisfies ClaudeEvent);

    expect(events).toHaveLength(1);
    expect((events[0] as any).type).toBe("agent_init");
    expect((events[0] as any).permissionMode).toBe("auto");
  });

  it("maps result.permission_denials to agent_result.permissionDenials (docs/138)", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);

    const events: unknown[] = [];
    adapter.on("event", (e) => events.push(e));

    inner.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "sess-block",
      permission_denials: [
        { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "curl x | bash" } },
      ],
    } satisfies ClaudeEvent);

    expect(events).toHaveLength(1);
    expect((events[0] as any).permissionDenials).toEqual([
      { toolName: "Bash", toolUseId: "t1", toolInput: { command: "curl x | bash" } },
    ]);
  });

  it("leaves permissionDenials undefined when there are no blocks", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);

    const events: unknown[] = [];
    adapter.on("event", (e) => events.push(e));

    inner.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "sess-ok",
    } satisfies ClaudeEvent);

    expect((events[0] as any).permissionDenials).toBeUndefined();
  });

  // docs/178 — native compaction signals. Before this, the `case "system"`
  // mapped EVERY system subtype to a bogus agent_init; now it discriminates.
  // docs/235 — the CLI can start a turn on its own when a backgrounded job
  // finishes. These four `system` subtypes were previously dropped by the
  // adapter's `default: return null`, which is why the orchestrator never knew.
  describe("background tasks / self-wake (docs/235)", () => {
    function harness() {
      const inner = new FakeInnerProcess();
      const adapter = new ClaudeAdapter(inner as any);
      const events: any[] = [];
      adapter.on("event", (e) => events.push(e));
      return { inner, events };
    }

    it("maps background_tasks_changed to the normalized task list", () => {
      const { inner, events } = harness();

      inner.emit("event", {
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [
          { task_id: "bqmczrwsu", task_type: "local_bash", description: "npm test" },
          { task_id: "other" },
        ],
      } as ClaudeEvent);

      expect(events).toEqual([{
        type: "agent_background_tasks",
        tasks: [
          { id: "bqmczrwsu", type: "local_bash", description: "npm test" },
          { id: "other", type: undefined, description: undefined },
        ],
      }]);
    });

    it("maps an empty task list to an explicit drained signal", () => {
      // `tasks: []` is how the CLI says "nothing outstanding" — it must reach
      // the runner, otherwise the count never falls back to zero.
      const { inner, events } = harness();
      inner.emit("event", { type: "system", subtype: "background_tasks_changed", tasks: [] } as ClaudeEvent);
      expect(events).toEqual([{ type: "agent_background_tasks", tasks: [] }]);
    });

    it("tolerates a background_tasks_changed with no tasks field", () => {
      const { inner, events } = harness();
      inner.emit("event", { type: "system", subtype: "background_tasks_changed" } as ClaudeEvent);
      expect(events).toEqual([{ type: "agent_background_tasks", tasks: [] }]);
    });

    it("maps task_notification to agent_self_wake", () => {
      const { inner, events } = harness();

      inner.emit("event", {
        type: "system",
        subtype: "task_notification",
        task_id: "bqmczrwsu",
        status: "completed",
        summary: 'Background command "npm test" completed (exit code 0)',
        output_file: "/tmp/claude-1000/x/tasks/bqmczrwsu.output",
      } as ClaudeEvent);

      expect(events).toEqual([{
        type: "agent_self_wake",
        taskId: "bqmczrwsu",
        status: "completed",
        summary: 'Background command "npm test" completed (exit code 0)',
      }]);
    });

    /**
     * docs/109 reqs 10–11 — for a backgrounded subagent this event is the ONLY
     * completion signal on the wire (no second `tool_result` ever arrives for
     * the Task), so dropping `tool_use_id` here is what left the card claiming
     * "Running in the background" forever. Payload is the real CLI 2.1.219
     * notification.
     */
    it("carries the tool_use_id and usage a backgrounded subagent reports", () => {
      const { inner, events } = harness();

      inner.emit("event", {
        type: "system",
        subtype: "task_notification",
        task_id: "af0615944a51b4583",
        tool_use_id: "toolu_013fUMwLfWGNwaaqVsj8ojXF",
        status: "completed",
        summary: "## Probe report\n\nThe number seven holds profound significance.",
        output_file: "/tmp/claude-1000/x/tasks/af0615944a51b4583.output",
        usage: { total_tokens: 10408, tool_uses: 0, duration_ms: 2757 },
      } as ClaudeEvent);

      expect(events).toEqual([{
        type: "agent_self_wake",
        taskId: "af0615944a51b4583",
        toolUseId: "toolu_013fUMwLfWGNwaaqVsj8ojXF",
        status: "completed",
        summary: "## Probe report\n\nThe number seven holds profound significance.",
        usage: { totalTokens: 10408, toolUses: 0, durationMs: 2757 },
      }]);
    });

    it("drops task_started / task_updated as redundant per-task deltas", () => {
      // Their effect is already covered by the authoritative
      // `background_tasks_changed` list emitted alongside them.
      const { inner, events } = harness();
      inner.emit("event", { type: "system", subtype: "task_started", task_id: "a" } as ClaudeEvent);
      inner.emit("event", {
        type: "system",
        subtype: "task_updated",
        task_id: "a",
        patch: { status: "completed" },
      } as ClaudeEvent);
      expect(events).toHaveLength(0);
    });

    it("drops thinking_tokens / task_progress as named cases, not unknown subtypes", () => {
      // Both are byte-shaped from a real CLI 2.1.224 capture (2026-08-17,
      // docs/272 Run 1). thinking_tokens is a per-tick estimate superseded by
      // the authoritative usage on `result`; task_progress is a per-task
      // liveness ping superseded by `background_tasks_changed` +
      // `task_notification`. The docs/272 run flagged them as undocumented
      // silent drops through the bare default — this locks them as deliberate.
      const { inner, events } = harness();
      inner.emit("event", {
        type: "system",
        subtype: "thinking_tokens",
        estimated_tokens: 39,
        estimated_tokens_delta: 34,
        uuid: "69794849-f59d-49aa-bd2f-4d23e5fbf3b1",
        session_id: "a80a2232-3941-46f5-9d9e-52440c0af284",
      } as ClaudeEvent);
      inner.emit("event", {
        type: "system",
        subtype: "task_progress",
        task_id: "a6886dc757aeebf72",
        tool_use_id: "toolu_016wHK8xXsiLixyUwqntzLvZ",
        description: "Running Count the number of files in the current directory",
        subagent_type: "general-purpose",
        usage: { total_tokens: 11373, tool_uses: 1, duration_ms: 3612 },
        last_tool_name: "Bash",
      } as ClaudeEvent);
      expect(events).toHaveLength(0);
    });
  });

  describe("compaction (docs/178)", () => {
    it("maps system/status status:'compacting' to agent_compaction_started", () => {
      const inner = new FakeInnerProcess();
      const adapter = new ClaudeAdapter(inner as any);
      const events: any[] = [];
      adapter.on("event", (e) => events.push(e));

      inner.emit("event", {
        type: "system",
        subtype: "status",
        status: "compacting",
      } as ClaudeEvent);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "agent_compaction_started", trigger: "auto" });
    });

    it("ignores non-compacting system/status events (e.g. the docs/138 'default' noise)", () => {
      const inner = new FakeInnerProcess();
      const adapter = new ClaudeAdapter(inner as any);
      const events: any[] = [];
      adapter.on("event", (e) => events.push(e));

      inner.emit("event", {
        type: "system",
        subtype: "status",
        status: "default",
      } as ClaudeEvent);

      expect(events).toHaveLength(0);
    });

    it("maps system/compact_boundary to agent_compacted with metadata", () => {
      const inner = new FakeInnerProcess();
      const adapter = new ClaudeAdapter(inner as any);
      const events: any[] = [];
      adapter.on("event", (e) => events.push(e));

      inner.emit("event", {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: {
          trigger: "manual",
          pre_tokens: 180_000,
          post_tokens: 42_000,
          duration_ms: 3200,
        },
      } as ClaudeEvent);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "agent_compacted",
        trigger: "manual",
        preTokens: 180_000,
        postTokens: 42_000,
        durationMs: 3200,
      });
    });

    it("maps a compact_boundary with no metadata to a bare agent_compacted", () => {
      const inner = new FakeInnerProcess();
      const adapter = new ClaudeAdapter(inner as any);
      const events: any[] = [];
      adapter.on("event", (e) => events.push(e));

      inner.emit("event", { type: "system", subtype: "compact_boundary" } as ClaudeEvent);

      expect(events).toEqual([{ type: "agent_compacted" }]);
    });

    it("compact() injects /compact on the streaming inner", async () => {
      const { StreamingClaudeProcess } = await import("./process.js");
      const sent: string[] = [];
      class FakeStreaming extends StreamingClaudeProcess {
        override sendUserMessage(text: string): void {
          sent.push(text);
        }
      }
      const inner = new FakeStreaming();
      const adapter = new ClaudeAdapter(inner as never);

      adapter.compact();
      expect(sent).toEqual(["/compact"]);
    });

    it("compact(instructions) appends custom args to the slash command (docs/178 §4)", async () => {
      const { StreamingClaudeProcess } = await import("./process.js");
      const sent: string[] = [];
      class FakeStreaming extends StreamingClaudeProcess {
        override sendUserMessage(text: string): void {
          sent.push(text);
        }
      }
      const inner = new FakeStreaming();
      const adapter = new ClaudeAdapter(inner as never);

      adapter.compact("keep the API notes");
      expect(sent).toEqual(["/compact keep the API notes"]);
    });

    it("compact() is a no-op on a non-streaming inner (orchestrator spawns a turn instead)", () => {
      const inner = new FakeInnerProcess();
      const adapter = new ClaudeAdapter(inner as any);
      adapter.compact();
      expect(inner.stdinData).toEqual([]);
    });

    it("advertises supportsCompaction", () => {
      const inner = new FakeInnerProcess();
      const adapter = new ClaudeAdapter(inner as any);
      expect(adapter.capabilities.supportsCompaction).toBe(true);
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

  it("maps a replayed user message (isReplay) to agent_user_replay (docs/140)", () => {
    // --replay-user-messages echoes an accepted steer as a delivery ack. The
    // adapter must surface it (concatenating its text blocks) so the
    // orchestrator can match it against the steer it sent — NOT drop it, and
    // NOT mis-map it to agent_tool_result.
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);

    const events: unknown[] = [];
    adapter.on("event", (e) => events.push(e));

    inner.emit("event", {
      type: "user",
      message: { content: [{ type: "text", text: "fix the typo too" }] },
      isReplay: true,
    } satisfies ClaudeEvent);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "agent_user_replay", text: "fix the typo too" });
  });

  it("joins multiple text blocks in a replayed user message", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);

    const events: unknown[] = [];
    adapter.on("event", (e) => events.push(e));

    inner.emit("event", {
      type: "user",
      message: { content: [{ type: "text", text: "part-a " }, { type: "text", text: "part-b" }] },
      isReplay: true,
    } satisfies ClaudeEvent);

    expect(events[0]).toEqual({ type: "agent_user_replay", text: "part-a part-b" });
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
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
    } satisfies ClaudeEvent);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "agent_result",
      status: "success",
      sessionId: "sess-123",
      cost: { totalUsd: 0.05 },
      tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
      contextTokens: undefined,
      contextWindow: undefined,
      durationMs: 1200,
      error: undefined,
    });
  });

  it("extracts per-turn context from the last iteration, not the sum", () => {
    // Multi-call turn: the CLI's top-level usage fields are sums across all
    // API calls in the turn. The dial would over-count by 3× here if we
    // used them as "current context size". The last iteration's
    // input + cache_read + cache_create is the real occupancy.
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);
    const events: unknown[] = [];
    adapter.on("event", (e) => events.push(e));

    inner.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "sess-multi",
      total_cost_usd: 0.10,
      duration_ms: 5000,
      usage: {
        // Sums across 3 iterations — would read as 300K of context if used.
        input_tokens: 30,
        output_tokens: 600,
        cache_read_input_tokens: 270_000,
        cache_creation_input_tokens: 30_000,
        iterations: [
          { input_tokens: 10, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 10_000 },
          { input_tokens: 10, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 10_000 },
          // Real per-turn context = 10 + 100_000 + 10_000 = 110_010
          { input_tokens: 10, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 10_000 },
        ],
      },
      modelUsage: {
        "claude-opus-4-7": {
          inputTokens: 30,
          outputTokens: 600,
          costUSD: 0.10,
          contextWindow: 1_000_000,
        },
      },
    } satisfies ClaudeEvent);

    expect(events).toHaveLength(1);
    expect((events[0] as any).contextTokens).toBe(110_010);
    expect((events[0] as any).contextWindow).toBe(1_000_000);
    // Turn-wide totals stay untouched — they're the right number for billing.
    expect((events[0] as any).tokens).toEqual({
      input: 30,
      output: 600,
      cacheRead: 270_000,
      cacheWrite: 30_000,
    });
  });

  it("uses the final assistant call when result iterations are absent", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);
    const events: unknown[] = [];
    adapter.on("event", (e) => events.push(e));

    inner.emit("event", {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "working" }],
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 180_000,
          cache_creation_input_tokens: 20_000,
        },
      },
    } satisfies ClaudeEvent);
    inner.emit("event", {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "done" }],
        usage: {
          input_tokens: 120,
          cache_read_input_tokens: 218_000,
          cache_creation_input_tokens: 1_000,
        },
      },
    } satisfies ClaudeEvent);
    inner.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "deepseek-via-claude",
      usage: {
        input_tokens: 218_500,
        output_tokens: 82_700,
        cache_read_input_tokens: 9_200_000,
      },
    } satisfies ClaudeEvent);

    expect(events).toHaveLength(3);
    expect((events[2] as any).contextTokens).toBe(219_120);
    expect((events[2] as any).tokens).toMatchObject({
      input: 218_500,
      output: 82_700,
      cacheRead: 9_200_000,
    });
  });

  it("does not use nested subagent usage as the main context", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);
    const events: unknown[] = [];
    adapter.on("event", (e) => events.push(e));

    inner.emit("event", {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "main" }],
        usage: { input_tokens: 50, cache_read_input_tokens: 100_000 },
      },
    } satisfies ClaudeEvent);
    inner.emit("event", {
      type: "assistant",
      parent_tool_use_id: "tool-1",
      message: {
        content: [{ type: "text", text: "nested" }],
        usage: { input_tokens: 50, cache_read_input_tokens: 900_000 },
      },
    } satisfies ClaudeEvent);
    inner.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "with-subagent",
      usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1_000_000 },
    } satisfies ClaudeEvent);

    expect((events[2] as any).contextTokens).toBe(100_050);
  });

  it("clears assistant context when a new one-shot turn starts", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);
    const events: unknown[] = [];
    adapter.on("event", (e) => events.push(e));

    inner.emit("event", {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "partial" }],
        usage: { input_tokens: 10, cache_read_input_tokens: 50_000 },
      },
    } satisfies ClaudeEvent);

    // Simulate starting another one-shot turn after the prior process ended
    // abnormally, without emitting a result that would normally clear state.
    adapter.run({ prompt: "retry", cwd: "/tmp" } as AgentRunParams);
    inner.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "retry",
      usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 80_000 },
    } satisfies ClaudeEvent);

    expect((events[1] as any).contextTokens).toBeUndefined();
  });

  it("clears assistant context when a resident process receives new input", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);
    const events: unknown[] = [];
    adapter.on("event", (e) => events.push(e));
    adapter.on("error", () => undefined);
    inner.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "partial" }], usage: { input_tokens: 10, cache_read_input_tokens: 50_000 } },
    } satisfies ClaudeEvent);
    adapter.sendUserMessage("next turn");
    inner.emit("event", {
      type: "result", subtype: "success", session_id: "next",
      usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 80_000 },
    } satisfies ClaudeEvent);
    const result = events.find((event) => (event as any).type === "agent_result") as any;
    expect(result.contextTokens).toBeUndefined();
  });

  it("clears the assistant fallback after each result", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);
    const events: unknown[] = [];
    adapter.on("event", (e) => events.push(e));
    inner.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "first" }], usage: { input_tokens: 10, cache_read_input_tokens: 50_000 } },
    } satisfies ClaudeEvent);
    for (const session_id of ["first", "second"]) {
      inner.emit("event", {
        type: "result", subtype: "success", session_id,
        usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 80_000 },
      } satisfies ClaudeEvent);
    }
    const results = events.filter((event) => (event as any).type === "agent_result") as any[];
    expect(results[0].contextTokens).toBe(50_010);
    expect(results[1].contextTokens).toBeUndefined();
  });

  it("prefers result iterations over the assistant fallback", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);
    const events: unknown[] = [];
    adapter.on("event", (e) => events.push(e));
    inner.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "done" }], usage: { input_tokens: 10, cache_read_input_tokens: 50_000 } },
    } satisfies ClaudeEvent);
    inner.emit("event", {
      type: "result", subtype: "success", session_id: "iterations-win",
      usage: {
        input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 80_000,
        iterations: [{ input_tokens: 20, cache_read_input_tokens: 60_000 }],
      },
    } satisfies ClaudeEvent);
    expect((events[1] as any).contextTokens).toBe(60_020);
  });

  it("ignores assistant usage that has no input context fields", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);
    const events: unknown[] = [];
    adapter.on("event", (e) => events.push(e));
    inner.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "error" }], usage: { output_tokens: 30 } },
    } satisfies ClaudeEvent);
    inner.emit("event", {
      type: "result", subtype: "success", session_id: "output-only",
      usage: { input_tokens: 20, output_tokens: 30, cache_read_input_tokens: 80_000 },
    } satisfies ClaudeEvent);
    expect((events[1] as any).contextTokens).toBeUndefined();
  });

  // The GLM shape, measured against `glm-5.3[1m]` on Z.ai's Anthropic endpoint
  // (2026-08-17): every `assistant` event's usage is zeroed because the CLI
  // snapshots it from `message_start`, `result.usage.iterations` is an EMPTY
  // array rather than absent, and the only real per-call numbers arrive in the
  // closing `message_delta` frame that `--include-partial-messages` re-emits.
  // Without that frame the dial summed the turn totals — 2.1M on a 1M window.
  it("uses the final message_delta when a provider zeroes assistant usage", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);
    const events: unknown[] = [];
    adapter.on("event", (e) => events.push(e));

    inner.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "reading" }], usage: { input_tokens: 0, output_tokens: 0 } },
    } satisfies ClaudeEvent);
    inner.emit("event", {
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "message_delta",
        usage: { input_tokens: 16_229, output_tokens: 216, cache_read_input_tokens: 8_512 },
      },
    } satisfies ClaudeEvent);
    inner.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "done" }], usage: { input_tokens: 0, output_tokens: 0 } },
    } satisfies ClaudeEvent);
    inner.emit("event", {
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "message_delta",
        usage: { input_tokens: 282, output_tokens: 32, cache_read_input_tokens: 24_704 },
      },
    } satisfies ClaudeEvent);
    inner.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "glm-via-claude",
      usage: {
        input_tokens: 16_511,
        output_tokens: 248,
        cache_read_input_tokens: 33_216,
        iterations: [],
      },
    } satisfies ClaudeEvent);

    // The two stream frames are consumed, not forwarded: the CLI's own
    // `assistant` events already carry the content.
    expect(events.map((e) => (e as any).type)).toEqual([
      "agent_assistant",
      "agent_assistant",
      "agent_result",
    ]);
    // The LAST call's prompt (282 + 24,704), not the 49,727 turn-wide sum.
    expect((events[2] as any).contextTokens).toBe(24_986);
    // Billing totals stay the turn-wide sums.
    expect((events[2] as any).tokens).toMatchObject({ input: 16_511, cacheRead: 33_216 });
  });

  // DeepSeek's shape once the flag applies to it too: BOTH sources are
  // populated, and the real wire order within a call is `assistant` first then
  // the closing `message_delta` — so the delta is what "latest wins" resolves
  // to. Measured 2026-08-17 on `deepseek-v4-flash`: the two agree exactly, and
  // the last call read 168 + 25,216.
  it("takes the closing delta when a provider populates both sources", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);
    const events: unknown[] = [];
    adapter.on("event", (e) => events.push(e));

    inner.emit("event", {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "first call" }],
        usage: { input_tokens: 25_195, cache_read_input_tokens: 0, output_tokens: 0 },
      },
    } satisfies ClaudeEvent);
    inner.emit("event", {
      type: "stream_event",
      event: {
        type: "message_delta",
        usage: { input_tokens: 25_195, cache_read_input_tokens: 0, output_tokens: 145 },
      },
    } satisfies ClaudeEvent);
    inner.emit("event", {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "last call" }],
        usage: { input_tokens: 168, cache_read_input_tokens: 25_216, output_tokens: 0 },
      },
    } satisfies ClaudeEvent);
    inner.emit("event", {
      type: "stream_event",
      event: {
        type: "message_delta",
        usage: { input_tokens: 168, cache_read_input_tokens: 25_216, output_tokens: 263 },
      },
    } satisfies ClaudeEvent);
    inner.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "deepseek-with-frames",
      usage: {
        input_tokens: 25_363,
        output_tokens: 408,
        cache_read_input_tokens: 25_216,
        iterations: [],
      },
    } satisfies ClaudeEvent);

    expect((events[2] as any).contextTokens).toBe(25_384);
  });

  it("ignores message_delta frames from a subagent call", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);
    const events: unknown[] = [];
    adapter.on("event", (e) => events.push(e));

    inner.emit("event", {
      type: "stream_event",
      event: { type: "message_delta", usage: { input_tokens: 50, cache_read_input_tokens: 100_000 } },
    } satisfies ClaudeEvent);
    inner.emit("event", {
      type: "stream_event",
      parent_tool_use_id: "tool-1",
      event: { type: "message_delta", usage: { input_tokens: 50, cache_read_input_tokens: 900_000 } },
    } satisfies ClaudeEvent);
    inner.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "delta-with-subagent",
      usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1_000_000 },
    } satisfies ClaudeEvent);

    expect((events[0] as any).contextTokens).toBe(100_050);
  });

  it("ignores message_start and content deltas, which carry no final usage", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);
    const events: unknown[] = [];
    adapter.on("event", (e) => events.push(e));

    inner.emit("event", {
      type: "stream_event",
      event: { type: "message_start", usage: { input_tokens: 500 } },
    } satisfies ClaudeEvent);
    inner.emit("event", {
      type: "stream_event",
      event: { type: "content_block_delta" },
    } satisfies ClaudeEvent);
    inner.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "start-frames-only",
      usage: { input_tokens: 40, output_tokens: 5, cache_read_input_tokens: 90_000 },
    } satisfies ClaudeEvent);

    expect(events).toHaveLength(1);
    expect((events[0] as any).contextTokens).toBeUndefined();
  });

  it("clears the message_delta reading after each result", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);
    const events: unknown[] = [];
    adapter.on("event", (e) => events.push(e));

    inner.emit("event", {
      type: "stream_event",
      event: { type: "message_delta", usage: { input_tokens: 12, cache_read_input_tokens: 40_000 } },
    } satisfies ClaudeEvent);
    for (const session_id of ["first", "second"]) {
      inner.emit("event", {
        type: "result", subtype: "success", session_id,
        usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 80_000 },
      } satisfies ClaudeEvent);
    }

    expect((events[0] as any).contextTokens).toBe(40_012);
    expect((events[1] as any).contextTokens).toBeUndefined();
  });

  it("prefers result iterations over a message_delta reading", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);
    const events: unknown[] = [];
    adapter.on("event", (e) => events.push(e));

    inner.emit("event", {
      type: "stream_event",
      event: { type: "message_delta", usage: { input_tokens: 10, cache_read_input_tokens: 50_000 } },
    } satisfies ClaudeEvent);
    inner.emit("event", {
      type: "result", subtype: "success", session_id: "iterations-still-win",
      usage: {
        input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 80_000,
        iterations: [{ input_tokens: 20, cache_read_input_tokens: 60_000 }],
      },
    } satisfies ClaudeEvent);

    expect((events[0] as any).contextTokens).toBe(60_020);
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

  it("maps rate_limit_event(five_hour) to agent_rate_limits with the session window", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);
    const events: any[] = [];
    adapter.on("event", (e) => events.push(e));

    inner.emit("event", {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        rateLimitType: "five_hour",
        utilization: 0.42,
        resetsAt: 1_800_000_000,
      },
    } satisfies ClaudeEvent);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "agent_rate_limits",
      session: { usedPct: 42, resetAt: new Date(1_800_000_000 * 1000).toISOString() },
      weekly: null,
    });
  });

  it("scales the CLI's 0–1 utilization fraction to a 0–100 percentage", () => {
    // The CLI forwards `anthropic-ratelimit-unified-*-utilization` verbatim and
    // that header is a FRACTION: one account read `0.06`/`0.66` in the headers
    // while /api/oauth/usage reported `6.0`/`67.0` for the same windows.
    // Treating it as a percentage rendered a real 92% session as "5h 1%".
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);
    const events: any[] = [];
    adapter.on("event", (e) => events.push(e));

    inner.emit("event", {
      type: "rate_limit_event",
      rate_limit_info: { rateLimitType: "five_hour", utilization: 0.92, resetsAt: 1_800_000_000 },
    } satisfies ClaudeEvent);
    inner.emit("event", {
      type: "rate_limit_event",
      rate_limit_info: { rateLimitType: "seven_day", utilization: 0.06, resetsAt: 1_900_000_000 },
    } satisfies ClaudeEvent);

    expect(events[1].session?.usedPct).toBeCloseTo(92, 6);
    expect(events[1].weekly?.usedPct).toBeCloseTo(6, 6);
  });

  it("passes through a utilization above 1 as an already-0–100 percentage", () => {
    // Defensive: a fraction can't exceed 1 for a capped window, so >1 means the
    // upstream scale changed. Better to render 42% than to multiply it to 100%.
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);
    const events: any[] = [];
    adapter.on("event", (e) => events.push(e));

    inner.emit("event", {
      type: "rate_limit_event",
      rate_limit_info: { rateLimitType: "five_hour", utilization: 42, resetsAt: 1_800_000_000 },
    } satisfies ClaudeEvent);

    expect(events[0].session?.usedPct).toBe(42);
  });

  it("accumulates five_hour + seven_day across separate events and re-emits both", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);
    const events: any[] = [];
    adapter.on("event", (e) => events.push(e));

    inner.emit("event", {
      type: "rate_limit_event",
      rate_limit_info: { rateLimitType: "five_hour", utilization: 0.12, resetsAt: 1_800_000_000 },
    } satisfies ClaudeEvent);
    inner.emit("event", {
      type: "rate_limit_event",
      rate_limit_info: { rateLimitType: "seven_day", utilization: 0.8, resetsAt: 1_900_000_000 },
    } satisfies ClaudeEvent);

    expect(events).toHaveLength(2);
    // Second event carries BOTH windows now that the adapter has seen each.
    expect(events[1].session?.usedPct).toBeCloseTo(12, 6);
    expect(events[1].weekly?.usedPct).toBeCloseTo(80, 6);
  });

  it("ignores rate_limit_event for sub-quotas (opus / sonnet / overage)", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);
    const events: any[] = [];
    adapter.on("event", (e) => events.push(e));

    for (const rateLimitType of ["seven_day_opus", "seven_day_sonnet", "overage"] as const) {
      inner.emit("event", {
        type: "rate_limit_event",
        rate_limit_info: { rateLimitType, utilization: 50, resetsAt: 1_800_000_000 },
      } satisfies ClaudeEvent);
    }

    expect(events).toHaveLength(0);
  });

  it("emits rate_limit_event with usedPct=null when utilization is missing but resetsAt is present", () => {
    // Claude CLI 2.1.140 only includes `utilization` once a warning threshold
    // trips (anthropics/claude-code#50518) — until then the rate_limit_event
    // carries just {rateLimitType, resetsAt}. The adapter must still surface
    // the window so the badge can render a countdown-only pill.
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);
    const events: any[] = [];
    adapter.on("event", (e) => events.push(e));

    inner.emit("event", {
      type: "rate_limit_event",
      rate_limit_info: { rateLimitType: "five_hour", resetsAt: 1_800_000_000 },
    } satisfies ClaudeEvent);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "agent_rate_limits",
      session: { usedPct: null, resetAt: new Date(1_800_000_000 * 1000).toISOString() },
      weekly: null,
    });
  });

  it("drops rate_limit_event when resetsAt is missing (nothing to render)", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);
    const events: any[] = [];
    adapter.on("event", (e) => events.push(e));

    inner.emit("event", {
      type: "rate_limit_event",
      rate_limit_info: { rateLimitType: "five_hour", utilization: 42 },
    } satisfies ClaudeEvent);

    expect(events).toHaveLength(0);
  });

  it("clamps utilization >100 and tolerates ms-shaped resetsAt", () => {
    const inner = new FakeInnerProcess();
    const adapter = new ClaudeAdapter(inner as any);
    const events: any[] = [];
    adapter.on("event", (e) => events.push(e));

    inner.emit("event", {
      type: "rate_limit_event",
      rate_limit_info: { rateLimitType: "five_hour", utilization: 120, resetsAt: 1_800_000_000_000 },
    } satisfies ClaudeEvent);

    expect(events[0].session?.usedPct).toBe(100);
    expect(events[0].session?.resetAt).toBe(new Date(1_800_000_000_000).toISOString());
  });

  it("delegates run() to inner process with options object", () => {
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
    expect(inner.lastRunOpts.prompt).toBe("Hello");
    expect(inner.lastRunOpts.sessionId).toBe("sess-1");
    expect(inner.lastRunOpts.systemPrompt).toBe("Be helpful");
    expect(inner.lastRunOpts.images).toEqual([{ data: "abc", mediaType: "image/png" }]);
    expect(inner.lastRunOpts.cwd).toBe("/workspace");
    expect(inner.lastRunOpts.permissionMode).toBe("auto");
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

  describe("setPermissionMode (docs/138)", () => {
    it("is a no-op when the inner process is not a StreamingClaudeProcess", () => {
      // The one-shot ClaudeProcess re-applies the mode at every spawn —
      // there's nothing to push mid-process. Adapter must not throw or
      // misroute a control_request to the wrong inner.
      const inner = new FakeInnerProcess();
      const adapter = new ClaudeAdapter(inner as any);

      adapter.setPermissionMode("plan");
      adapter.setPermissionMode("auto");
      adapter.setPermissionMode(undefined);

      expect(inner.stdinData).toEqual([]);
    });

    it("forwards to the streaming inner with the ShipIt → CLI mapping", async () => {
      // Build a fake StreamingClaudeProcess subclass so `instanceof` passes
      // without spawning a real CLI. Capture the cliMode that the adapter
      // pushes through `inner.setPermissionMode`.
      const { StreamingClaudeProcess } = await import("./process.js");
      const calls: string[] = [];
      class FakeStreaming extends StreamingClaudeProcess {
        override setPermissionMode(cliMode: string): void {
          calls.push(cliMode);
        }
      }
      const inner = new FakeStreaming();
      const adapter = new ClaudeAdapter(inner as never);

      adapter.setPermissionMode("plan");
      adapter.setPermissionMode("guarded");
      adapter.setPermissionMode("auto");
      adapter.setPermissionMode(undefined);

      // plan → "plan", guarded → CLI "auto" (the classifier-gated mode),
      // ShipIt "auto" / undefined → CLI "default" (no-flag default the CLI
      // reports in its init event).
      expect(calls).toEqual(["plan", "auto", "default", "default"]);
    });
  });

  // docs/088 — Per-MCP-server liveness signal extracted from the Claude CLI
  // init event. These tests pin the contract that the worker depends on for
  // its `mcp_server_status` SSE broadcasts.
  describe("MCP server liveness (docs/088)", () => {
    it("emits mcp_status for each entry in the init event's mcp_servers", () => {
      const inner = new FakeInnerProcess();
      const adapter = new ClaudeAdapter(inner as any);

      const batches: McpServerStatus[][] = [];
      adapter.on("mcp_status", (s) => batches.push(s));

      inner.emit("event", {
        type: "system",
        subtype: "init",
        session_id: "sess-1",
        mcp_servers: [
          { name: "linear", status: "connected" },
          { name: "sentry", status: "failed" },
          { name: "notion", status: "needs-auth" },
        ],
      } satisfies ClaudeEvent);

      expect(batches).toHaveLength(1);
      expect(batches[0]).toEqual([
        { name: "linear", state: "loaded" },
        { name: "sentry", state: "failed", reason: "connection failed" },
        { name: "notion", state: "failed", reason: "authentication required" },
      ]);
    });

    it("does not emit mcp_status when the init event has no mcp_servers field", () => {
      const inner = new FakeInnerProcess();
      const adapter = new ClaudeAdapter(inner as any);

      const batches: McpServerStatus[][] = [];
      adapter.on("mcp_status", (s) => batches.push(s));

      inner.emit("event", {
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      } satisfies ClaudeEvent);

      expect(batches).toHaveLength(0);
    });

    it("does not emit mcp_status when mcp_servers is an empty array", () => {
      // An init event with an empty mcp_servers array is the CLI explicitly
      // reporting "no MCP servers configured" — there's nothing to surface
      // and emitting an empty batch would just be noise on the SSE channel.
      const inner = new FakeInnerProcess();
      const adapter = new ClaudeAdapter(inner as any);

      const batches: McpServerStatus[][] = [];
      adapter.on("mcp_status", (s) => batches.push(s));

      inner.emit("event", {
        type: "system",
        subtype: "init",
        session_id: "sess-1",
        mcp_servers: [],
      } satisfies ClaudeEvent);

      expect(batches).toHaveLength(0);
    });

    it("still maps the init event to agent_init alongside mcp_status", () => {
      // The MCP side-channel must not displace the normal agent_init flow —
      // model context and session tracking depend on it firing on every init.
      const inner = new FakeInnerProcess();
      const adapter = new ClaudeAdapter(inner as any);

      const events: unknown[] = [];
      const batches: McpServerStatus[][] = [];
      adapter.on("event", (e) => events.push(e));
      adapter.on("mcp_status", (s) => batches.push(s));

      inner.emit("event", {
        type: "system",
        subtype: "init",
        session_id: "sess-1",
        model: "claude-opus-4-7",
        tools: ["Read"],
        mcp_servers: [{ name: "linear", status: "connected" }],
      } satisfies ClaudeEvent);

      expect(events).toHaveLength(1);
      expect((events[0] as { type: string }).type).toBe("agent_init");
      expect(batches).toHaveLength(1);
    });
  });

  describe("mapCliMcpStatus", () => {
    it("maps 'connected' to loaded without a reason", () => {
      expect(mapCliMcpStatus({ name: "x", status: "connected" })).toEqual({
        name: "x",
        state: "loaded",
      });
    });

    it("maps 'needs-auth' to failed with an auth-required reason", () => {
      // OAuth-style MCP servers (Linear hosted, Gamma, etc.) report
      // `needs-auth` until the user completes Phase 2's OAuth flow.
      // For Phase 1 we surface this as `failed` with explanatory text;
      // when 088 Phase 2 lands we'll route this to a richer state.
      expect(mapCliMcpStatus({ name: "linear", status: "needs-auth" })).toEqual({
        name: "linear",
        state: "failed",
        reason: "authentication required",
      });
    });

    it("maps 'failed' to failed with a connection-failed reason", () => {
      expect(mapCliMcpStatus({ name: "x", status: "failed" })).toEqual({
        name: "x",
        state: "failed",
        reason: "connection failed",
      });
    });

    it("preserves unknown CLI statuses in the reason so we don't drop a new signal silently", () => {
      // Future-proofing: if Anthropic adds a new status value (e.g.,
      // "rate-limited"), we still surface a useful red badge — the literal
      // status string makes it into the reason so the user / debug logs
      // see what the CLI actually said.
      expect(mapCliMcpStatus({ name: "x", status: "rate-limited" })).toEqual({
        name: "x",
        state: "failed",
        reason: "unknown status: rate-limited",
      });
    });
  });
});
