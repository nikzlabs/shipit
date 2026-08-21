/**
 * docs/109 reqs 1, 5, 8. The parsing half is covered exhaustively in
 * `client/utils/group-events-by-parent.test.ts` (this module's original home);
 * what is tested here is what moved it: metadata extraction, the
 * background-launch recognizer, and the clamp the projection ships.
 */

import { describe, it, expect } from "vitest";
import {
  parseReportMeta,
  isBackgroundLaunchAck,
  sliceSubagentReport,
  parseSubagentReport,
  REPORT_SLICE_LINES,
  REPORT_STRIP_FLOOR_BYTES,
} from "./subagent-report.js";

const longText = Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n");

describe("parseReportMeta", () => {
  it("pulls the three numbers the chips draw", () => {
    expect(parseReportMeta("agentId: a1\nsubagent_tokens: 21437\ntool_uses: 11\nduration_ms: 102400"))
      .toEqual({ tokens: 21437, toolUses: 11, durationMs: 102400 });
  });

  /**
   * req 5 — the agent id is an internal handle for `SendMessage` and the CLI's
   * own acknowledgement says not to surface it. Dropped here rather than at the
   * render site so there is exactly one place to check it can't reach the DOM.
   */
  it("never returns the agent id", () => {
    const meta = parseReportMeta("agentId: a90130de265682eb8\ntool_uses: 3");
    expect(JSON.stringify(meta)).not.toContain("a90130de265682eb8");
    expect(meta).toEqual({ toolUses: 3 });
  });

  it("is null when there is no footer, and when the footer has no numbers", () => {
    expect(parseReportMeta(null)).toBeNull();
    expect(parseReportMeta("agentId: a1")).toBeNull();
  });
});

describe("isBackgroundLaunchAck", () => {
  const ACK = [
    "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it.)",
    "agentId: a90130de265682eb8 (internal ID - do not mention to user.)",
    "output_file: /tmp/claude-1000/-workspace/637e/tasks/a90130de265682eb8.output",
  ].join("\n");

  it("recognizes the acknowledgement the CLI returns for a backgrounded Task", () => {
    expect(isBackgroundLaunchAck(ACK)).toBe(true);
  });

  /**
   * The narrowness guard. A false positive hides a real report, and this repo's
   * own docs quote the opening sentence — so the phrase alone is not the test.
   */
  it("is false for a report that merely quotes the phrase", () => {
    expect(isBackgroundLaunchAck('The CLI says "Async agent launched successfully" and returns an id.')).toBe(false);
  });

  it("is false for an ordinary report", () => {
    expect(isBackgroundLaunchAck("## Findings\n\nAll three checks passed.")).toBe(false);
  });

  /**
   * From the cross-agent review: the sentence and the own-line corroborator can
   * BOTH occur in a genuine report about backgrounded agents — one that opens
   * by quoting the CLI and later shows an `agentId:` line in a fenced block.
   * Hiding a real report is the expensive direction, so length is a third
   * required signal: the real acknowledgement is ~700 bytes of fixed prose.
   */
  it("is false for a long report that opens with the sentence and quotes the fields", () => {
    const report = [
      "Async agent launched successfully is what the CLI returns here.",
      "",
      "```",
      "agentId: a90130de265682eb8",
      "output_file: /tmp/x.output",
      "```",
      "",
      Array.from({ length: 60 }, (_, i) => `Finding ${i}: a real thing the subagent found.`).join("\n"),
    ].join("\n");

    expect(isBackgroundLaunchAck(report)).toBe(false);
  });
});

describe("sliceSubagentReport", () => {
  it("leaves a report that already fits alone, markers and all", () => {
    expect(sliceSubagentReport("All three checks passed.")).toBeNull();
    // Just under the floor: the markers would cost more than the body.
    expect(sliceSubagentReport("x".repeat(REPORT_STRIP_FLOOR_BYTES))).toBeNull();
  });

  it("clamps a plain-string report to a prefix, keeping its shape", () => {
    const sliced = sliceSubagentReport(longText);

    expect(sliced).not.toBeNull();
    expect(sliced!.content.split("\n")).toHaveLength(REPORT_SLICE_LINES);
    expect(longText.startsWith(sliced!.content)).toBe(true);
    expect(sliced!.totalLines).toBe(120);
  });

  /**
   * The reason this function exists instead of `sliceBody`. The CLI's normal
   * encoding is a `JSON.stringify`'d block array — a SINGLE line — so a generic
   * line cap never fires and a byte cap cuts mid-array. The client would then
   * fail to parse it and render raw JSON, which is the planning#289 bug returning by
   * a different route.
   */
  it("clamps the text inside a block array and leaves valid JSON", () => {
    const content = JSON.stringify([
      { type: "text", text: longText },
      { type: "text", text: "agentId: a1\nsubagent_tokens: 900\ntool_uses: 2" },
    ]);

    const sliced = sliceSubagentReport(content);

    expect(sliced).not.toBeNull();
    const reparsed = parseSubagentReport(sliced!.content);
    expect(reparsed.text.split("\n")).toHaveLength(REPORT_SLICE_LINES);
    expect(longText.startsWith(reparsed.text)).toBe(true);
    // req 5 — the footer feeds chips that are visible with no click, so it
    // survives the clamp whole.
    expect(reparsed.meta).toContain("subagent_tokens: 900");
  });

  it("bounds a report that is one enormous line", () => {
    const sliced = sliceSubagentReport("x".repeat(200_000));

    expect(sliced).not.toBeNull();
    expect(sliced!.content.length).toBeLessThan(200_000);
    expect(sliced!.totalBytes).toBe(200_000);
  });

  it("never splits a UTF-8 codepoint", () => {
    const sliced = sliceSubagentReport("🙂".repeat(50_000));
    expect(sliced!.content).not.toContain("�");
  });

  /**
   * From the cross-agent review: an earlier version rebuilt the array as a
   * fresh two-element `[text, meta]`, which DELETED any image a subagent had
   * returned alongside its report. Rebuilding in place keeps every block this
   * module doesn't model.
   */
  it("keeps non-text blocks — a report can carry a screenshot", () => {
    const content = JSON.stringify([
      { type: "text", text: longText },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "tool_uses: 4" },
    ]);

    const sliced = sliceSubagentReport(content);

    const blocks = JSON.parse(sliced!.content) as { type: string }[];
    expect(blocks.map((b) => b.type)).toEqual(["text", "image", "text"]);
    expect(parseSubagentReport(sliced!.content).meta).toBe("tool_uses: 4");
  });
});
