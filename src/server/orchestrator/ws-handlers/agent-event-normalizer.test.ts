import { describe, expect, it, vi } from "vitest";
import {
  cliPermissionModeToApplied,
  createAgentToolTracker,
  extractToolResults,
  isWellFormedAskUserQuestion,
  stampToolDurations,
  summarizeCrashReason,
} from "./agent-event-normalizer.js";
import type { AgentEvent, ClaudeContentBlockToolUse, WsServerMessage } from "../../shared/types.js";

const toolResultEvent = (
  blocks: { tool_use_id: string; content?: string; is_error?: boolean; duration_ms?: number }[],
): AgentEvent =>
  ({
    type: "agent_tool_result",
    content: blocks.map((b) => ({ type: "tool_result", ...b })),
  }) as unknown as AgentEvent;

describe("per-tool timing derivation (docs/185)", () => {
  describe("stampToolDurations", () => {
    it("stamps duration_ms = now - start for results with a recorded start", () => {
      const starts = new Map<string, number>([["t1", 1000]]);
      const out = stampToolDurations(toolResultEvent([{ tool_use_id: "t1", content: "ok" }]), starts, 1450);
      const block = (out as unknown as { content: Record<string, unknown>[] }).content[0];
      expect(block.duration_ms).toBe(450);
    });

    it("leaves results without a recorded start untouched (returns same reference)", () => {
      const starts = new Map<string, number>();
      const event = toolResultEvent([{ tool_use_id: "unknown", content: "ok" }]);
      const out = stampToolDurations(event, starts, 1450);
      expect(out).toBe(event);
    });

    it("does not overwrite a duration that is already present", () => {
      const starts = new Map<string, number>([["t1", 1000]]);
      const out = stampToolDurations(toolResultEvent([{ tool_use_id: "t1", duration_ms: 7 }]), starts, 9999);
      const block = (out as unknown as { content: Record<string, unknown>[] }).content[0];
      expect(block.duration_ms).toBe(7);
    });

    it("clamps a negative delta (clock skew) to zero", () => {
      const starts = new Map<string, number>([["t1", 2000]]);
      const out = stampToolDurations(toolResultEvent([{ tool_use_id: "t1" }]), starts, 1000);
      const block = (out as unknown as { content: Record<string, unknown>[] }).content[0];
      expect(block.duration_ms).toBe(0);
    });

    it("is a no-op for non-tool-result events", () => {
      const event = { type: "agent_assistant", content: [{ type: "text", text: "hi" }] } as unknown as AgentEvent;
      expect(stampToolDurations(event, new Map(), 1)).toBe(event);
    });
  });

  describe("extractToolResults", () => {
    it("carries a stamped duration_ms into the entry's durationMs", () => {
      const event = toolResultEvent([{ tool_use_id: "t1", content: "ok", duration_ms: 320 }]);
      expect(extractToolResults(event)[0]).toMatchObject({ toolUseId: "t1", content: "ok", durationMs: 320 });
    });

    it("omits durationMs when no duration was stamped", () => {
      const entry = extractToolResults(toolResultEvent([{ tool_use_id: "t1", content: "ok" }]))[0];
      expect(entry.durationMs).toBeUndefined();
    });
  });
});

describe("cliPermissionModeToApplied", () => {
  it("maps the CLI's authoritative init modes back to ShipIt applied modes", () => {
    expect(cliPermissionModeToApplied("plan")).toBe("plan");
    expect(cliPermissionModeToApplied("auto")).toBe("guarded");
    expect(cliPermissionModeToApplied("default")).toBeUndefined();
  });

  it("returns the 'unrecognized' sentinel for absent / unknown modes", () => {
    expect(cliPermissionModeToApplied(undefined)).toBe("unrecognized");
    expect(cliPermissionModeToApplied("something-else")).toBe("unrecognized");
  });
});

describe("isWellFormedAskUserQuestion", () => {
  const tool = (name: string, input: unknown): ClaudeContentBlockToolUse =>
    ({ type: "tool_use", id: "t", name, input }) as ClaudeContentBlockToolUse;

  it("is true only for AskUserQuestion with a non-empty questions array", () => {
    expect(isWellFormedAskUserQuestion(tool("AskUserQuestion", { questions: [{ header: "h" }] }))).toBe(true);
  });

  it("is false for AskUserQuestion with missing / empty questions", () => {
    expect(isWellFormedAskUserQuestion(tool("AskUserQuestion", {}))).toBe(false);
    expect(isWellFormedAskUserQuestion(tool("AskUserQuestion", { questions: [] }))).toBe(false);
  });

  it("is false for any other tool", () => {
    expect(isWellFormedAskUserQuestion(tool("Read", { questions: [{ header: "h" }] }))).toBe(false);
  });
});

describe("summarizeCrashReason", () => {
  it("returns a fallback for empty content", () => {
    expect(summarizeCrashReason("   ")).toBe("tool call failed");
  });

  it("keeps only the first line", () => {
    expect(summarizeCrashReason("boom\nstack frame 1\nstack frame 2")).toBe("boom");
  });

  it("truncates a long first line with an ellipsis", () => {
    const out = summarizeCrashReason("x".repeat(500));
    expect(out.length).toBe(240);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("createAgentToolTracker (docs/088 MCP crash attribution)", () => {
  it("emits a deduped mcp_server_status crash for an MCP tool's is_error result", () => {
    const emitted: WsServerMessage[] = [];
    const tracker = createAgentToolTracker("session-1", (m) => emitted.push(m));
    tracker.recordToolUses([{ id: "t1", name: "mcp__acme__do_thing" }]);

    tracker.reportMcpCrashesFromResults([
      { toolUseId: "t1", content: "exploded", isError: true },
    ]);
    // A second failure from the same server is deduped per-turn-per-server.
    tracker.reportMcpCrashesFromResults([
      { toolUseId: "t1", content: "again", isError: true },
    ]);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "mcp_server_status",
      sessionId: "session-1",
      name: "acme",
      state: "crashed",
      reason: "exploded",
    });
  });

  it("ignores non-error results and non-MCP tool failures", () => {
    const emitted: WsServerMessage[] = [];
    const tracker = createAgentToolTracker("session-1", (m) => emitted.push(m));
    tracker.recordToolUses([
      { id: "ok", name: "mcp__acme__do_thing" },
      { id: "plain", name: "Read" },
    ]);
    tracker.reportMcpCrashesFromResults([
      { toolUseId: "ok", content: "fine", isError: false },
      { toolUseId: "plain", content: "boom", isError: true },
      { toolUseId: "unknown", content: "boom", isError: true },
    ]);
    expect(emitted).toHaveLength(0);
  });

  it("records a first-observation start time consumed by stampToolDurations", () => {
    const tracker = createAgentToolTracker("session-1", vi.fn());
    tracker.recordToolUses([{ id: "t1", name: "Read" }]);
    const start = tracker.toolUseStartTimes.get("t1");
    expect(typeof start).toBe("number");
    // First observation wins — a later re-record never moves the start.
    tracker.recordToolUses([{ id: "t1", name: "Read" }]);
    expect(tracker.toolUseStartTimes.get("t1")).toBe(start);
  });
});
