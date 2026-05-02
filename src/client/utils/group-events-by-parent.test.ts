import { describe, it, expect } from "vitest";
import { groupEventsByParent, findSubagentFinalReport } from "./group-events-by-parent.js";
import type { SubagentEvent, ToolResultBlock } from "../components/MessageList.js";

describe("groupEventsByParent", () => {
  it("returns an empty map for undefined or empty input", () => {
    expect(groupEventsByParent(undefined).size).toBe(0);
    expect(groupEventsByParent([]).size).toBe(0);
  });

  it("groups assistant + tool_result events by parentToolUseId, preserving order", () => {
    const events: SubagentEvent[] = [
      {
        kind: "assistant",
        parentToolUseId: "task-1",
        text: "Reading the file...",
        toolUse: [{ type: "tool_use", id: "sub-1", name: "Read", input: { file_path: "a.ts" } }],
      },
      {
        kind: "tool_result",
        parentToolUseId: "task-1",
        toolResults: [{ toolUseId: "sub-1", content: "file contents" }],
      },
      {
        kind: "assistant",
        parentToolUseId: "task-1",
        text: "Done.",
        toolUse: [],
      },
    ];

    const grouped = groupEventsByParent(events);
    expect(grouped.size).toBe(1);
    const tree = grouped.get("task-1")!;
    expect(tree.steps).toHaveLength(3);
    expect(tree.steps[0].kind).toBe("assistant");
    expect(tree.steps[1].kind).toBe("tool_result");
    expect(tree.steps[2].kind).toBe("assistant");
  });

  it("separates events from different parent tools", () => {
    const events: SubagentEvent[] = [
      { kind: "assistant", parentToolUseId: "task-A", text: "A", toolUse: [] },
      { kind: "assistant", parentToolUseId: "task-B", text: "B", toolUse: [] },
      { kind: "assistant", parentToolUseId: "task-A", text: "A2", toolUse: [] },
    ];

    const grouped = groupEventsByParent(events);
    expect(grouped.size).toBe(2);
    expect(grouped.get("task-A")!.steps).toHaveLength(2);
    expect(grouped.get("task-B")!.steps).toHaveLength(1);
  });
});

describe("findSubagentFinalReport", () => {
  it("returns the matching tool_result by parent tool id", () => {
    const results: ToolResultBlock[] = [
      { toolUseId: "other-tool", content: "unrelated" },
      { toolUseId: "task-1", content: "## Final Report\n\nDone." },
    ];
    const report = findSubagentFinalReport("task-1", results);
    expect(report?.content).toContain("Final Report");
  });

  it("returns undefined when no matching result exists", () => {
    expect(findSubagentFinalReport("task-1", undefined)).toBeUndefined();
    expect(findSubagentFinalReport("task-1", [])).toBeUndefined();
    expect(findSubagentFinalReport("task-1", [{ toolUseId: "x", content: "y" }])).toBeUndefined();
  });
});
