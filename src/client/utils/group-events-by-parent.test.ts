import { describe, it, expect } from "vitest";
import { groupEventsByParent, findSubagentFinalReport, parseSubagentReport } from "./group-events-by-parent.js";
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

/**
 * SHI-287 — the Claude CLI returns a subagent's `tool_result` as a JSON-encoded
 * block array whenever the reply has more than one block, which is the normal
 * case because the CLI appends its own accounting footer. `SubagentCall` used
 * to hand that string straight to the markdown renderer, so the user read
 * `[{"type":"text","text":"…"}]` with escaped newlines instead of the report.
 */
describe("parseSubagentReport", () => {
  /**
   * The exact shape observed from Claude Code CLI 2.1.219 on a live dogfood
   * turn — the report block, then the CLI's `agentId` footer. Kept verbatim
   * rather than tidied, because "what the CLI actually emits" is the whole
   * point of this function.
   */
  const REAL_REPORT = JSON.stringify([
    {
      type: "text",
      text: "File: /workspace/README.md\n- Words: 2145\n- Lines: 264\n- Bytes: 15379",
    },
    {
      type: "text",
      text: "agentId: af658a55f1a8b9594\nsubagent_tokens: 49171\ntool_uses: 1\nduration_ms: 5411",
    },
  ]);

  it("extracts the report text from the CLI's real block-array shape", () => {
    const parsed = parseSubagentReport(REAL_REPORT);
    expect(parsed.text).toBe("File: /workspace/README.md\n- Words: 2145\n- Lines: 264\n- Bytes: 15379");
    // No JSON punctuation survives into what the user reads.
    expect(parsed.text).not.toContain('"type"');
    expect(parsed.text).not.toContain("\\n");
  });

  it("separates the CLI's accounting footer so it can be demoted, not read as report", () => {
    const parsed = parseSubagentReport(REAL_REPORT);
    expect(parsed.meta).toContain("subagent_tokens: 49171");
    expect(parsed.text).not.toContain("agentId");
  });

  /**
   * The non-array path must be byte-identical, since a single-block reply is
   * delivered as a plain string and is by far the more common shape.
   */
  it("returns a plain-string report untouched", () => {
    const plain = "## Findings\n\nAll three checks passed.";
    expect(parseSubagentReport(plain)).toEqual({ text: plain, meta: null });
  });

  it("returns content untouched when it starts with [ but is not JSON", () => {
    // A markdown report may legitimately open with a link or a checkbox.
    const md = "[the linked doc](http://example.com) explains the rest";
    expect(parseSubagentReport(md)).toEqual({ text: md, meta: null });
  });

  it("returns content untouched for a JSON array that is not blocks", () => {
    expect(parseSubagentReport("[1, 2, 3]").text).toBe("[1, 2, 3]");
  });

  it("joins multiple report blocks and keeps them all when there is no footer", () => {
    const content = JSON.stringify([
      { type: "text", text: "First half." },
      { type: "text", text: "Second half." },
    ]);
    const parsed = parseSubagentReport(content);
    expect(parsed.text).toBe("First half.\n\nSecond half.");
    expect(parsed.meta).toBeNull();
  });

  /**
   * The footer has no structural marker — it is an ordinary `type: "text"`
   * block — so recognition is deliberately narrow. A false positive would eat
   * someone's report; a false negative just renders it as text, which is what
   * happened before this function existed.
   */
  it("does not mistake a report that merely contains colons for the footer", () => {
    const content = JSON.stringify([
      { type: "text", text: "Summary" },
      { type: "text", text: "Result: everything passed\nNote: see line 40" },
    ]);
    const parsed = parseSubagentReport(content);
    expect(parsed.meta).toBeNull();
    expect(parsed.text).toContain("Result: everything passed");
  });

  /**
   * docs/109 req 5 — this used to assert the opposite ("a one-block reply IS
   * the report; stripping it would blank the card"), which meant a subagent
   * that returned nothing but accounting had its internal `agentId` rendered to
   * the user as prose. The `texts.length > 1` guard was protecting against a
   * case the recognizer already excludes: a block only gets here if EVERY line
   * is a `key: value` with a key the CLI emits, which no prose report is. An
   * empty report body is the truthful rendering of a reply that carried none.
   */
  it("treats a lone footer-shaped block as the footer, not as the report", () => {
    const content = JSON.stringify([{ type: "text", text: "agentId: abc\ntool_uses: 0" }]);
    const parsed = parseSubagentReport(content);
    expect(parsed.text).toBe("");
    expect(parsed.meta).toBe("agentId: abc\ntool_uses: 0");
  });

  it("keeps a trailing footer-shaped block that is not last", () => {
    const content = JSON.stringify([
      { type: "text", text: "agentId: abc\ntool_uses: 0" },
      { type: "text", text: "The actual report." },
    ]);
    const parsed = parseSubagentReport(content);
    expect(parsed.meta).toBeNull();
    expect(parsed.text).toContain("agentId: abc");
  });

  /**
   * A block array with no text at all tells us nothing renderable; returning
   * "" would blank a report that does exist in some shape we don't model.
   */
  it("falls back to the raw content when a parsed array holds no text blocks", () => {
    const content = JSON.stringify([{ type: "image", source: { data: "iVBOR", media_type: "image/png" } }]);
    expect(parseSubagentReport(content).text).toBe(content);
  });

  it("handles an empty report without throwing", () => {
    expect(parseSubagentReport("")).toEqual({ text: "", meta: null });
  });
});
