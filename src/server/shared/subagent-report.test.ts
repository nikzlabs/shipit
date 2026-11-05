import { describe, it, expect } from "vitest";
import {
  parseReportMeta,
  isBackgroundLaunchAck,
  sliceSubagentReport,
  parseSubagentReport,
  STOPPED_TEXT,
  REPORT_STRIP_FLOOR_BYTES,
} from "./subagent-report.js";

const longText = Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n");

describe("parseReportMeta", () => {
  it("pulls the three numbers the chips draw", () => {
    expect(parseReportMeta("agentId: a1\nsubagent_tokens: 21437\ntool_uses: 11\nduration_ms: 102400"))
      .toEqual({ tokens: 21437, toolUses: 11, durationMs: 102400 });
  });

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

  it("is false for a report that merely quotes the phrase", () => {
    expect(isBackgroundLaunchAck('The CLI says "Async agent launched successfully" and returns an id.')).toBe(false);
  });

  it("is false for an ordinary report", () => {
    expect(isBackgroundLaunchAck("## Findings\n\nAll three checks passed.")).toBe(false);
  });

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

describe("sliceSubagentReport (docs/339: the transcript draws no report)", () => {
  const ACK = [
    "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)",
    "agentId: a90130de265682eb8 (internal ID - do not mention to user.)",
    "output_file: /tmp/claude-1000/-workspace/637e/tasks/a90130de265682eb8.output",
  ].join("\n");

  it("leaves a report that already fits alone, markers and all", () => {
    expect(sliceSubagentReport("All three checks passed.")).toBeNull();
    expect(sliceSubagentReport("x".repeat(REPORT_STRIP_FLOOR_BYTES))).toBeNull();
  });

  it("ships a plain-string report's text empty, recording what it held", () => {
    const sliced = sliceSubagentReport(longText);
    expect(sliced).toEqual({ content: "", totalLines: 120, totalBytes: longText.length });
  });

  it("empties the text inside a block array, keeps the footer and leaves valid JSON", () => {
    const content = JSON.stringify([
      { type: "text", text: longText },
      { type: "text", text: "agentId: a1\nsubagent_tokens: 900\ntool_uses: 2" },
    ]);

    const reparsed = parseSubagentReport(sliceSubagentReport(content)!.content);
    expect(reparsed.text).toBe("");
    expect(reparsed.meta).toContain("subagent_tokens: 900");
  });

  it("bounds a report that is one enormous line", () => {
    const sliced = sliceSubagentReport("x".repeat(200_000));
    expect(sliced!.content).toBe("");
    expect(sliced!.totalBytes).toBe(200_000);
  });

  it("keeps non-text blocks — a report can carry a screenshot", () => {
    const content = JSON.stringify([
      { type: "text", text: longText },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "tool_uses: 4" },
    ]);

    const blocks = JSON.parse(sliceSubagentReport(content)!.content) as { type: string }[];
    expect(blocks.map((b) => b.type)).toEqual(["text", "image", "text"]);
    expect(parseSubagentReport(sliceSubagentReport(content)!.content).meta).toBe("tool_uses: 4");
  });

  it("keeps whole the two texts a sub-agent's line reads its status from", () => {
    expect(sliceSubagentReport(ACK)).toBeNull();
    const stopped = JSON.stringify([
      { type: "text", text: STOPPED_TEXT },
      { type: "text", text: "tool_uses: 4\nduration_ms: 9000" },
    ]);
    expect(STOPPED_TEXT.length).toBeLessThanOrEqual(REPORT_STRIP_FLOOR_BYTES);
    expect(sliceSubagentReport(stopped)).toBeNull();
  });
});
