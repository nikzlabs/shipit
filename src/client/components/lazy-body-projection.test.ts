/**
 * docs/244 — the cross-layer contracts between the orchestrator's wire
 * projection and the client code that renders what it produces.
 *
 * `transcript-projection.test.ts` proves the projection does what it intends;
 * these prove the *client* still works on the output. They live here rather
 * than beside the projection because they drive the real client parsers
 * (`parseContentForImages`, `parsePresentToolResult`, `countLines`) — a
 * server-side test would have to restate those rules, which is exactly the
 * duplication that lets the two layers drift apart unnoticed.
 */

import { describe, it, expect } from "vitest";
import { parseContentForImages } from "./ToolResult.js";
import { parsePresentToolResult } from "./message-tools.js";
import { countLines } from "./DiffBlock.js";
import type { ToolUseBlock, ToolResultBlock } from "./MessageList/types.js";
import { projectToolResult, projectToolUse, imageUrl, imageHash } from "../../server/orchestrator/transcript-projection.js";

const png = Buffer.from("fake-png-bytes").toString("base64");

describe("an image-bearing result still parses after substitution", () => {
  /**
   * The projection rewrites the base64 out of an MCP screenshot result but has
   * to leave the block array valid JSON, because `parseContentForImages` is
   * what splits it back into text + images. If the substitution ever broke the
   * structure the parser returns null and the screenshot degrades into a wall
   * of raw JSON — visible, but only to a human looking at it.
   */
  const content = JSON.stringify([
    { type: "text", text: "Screenshot captured" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
  ]);

  it("yields the text and a URL-backed image, with no base64 left", () => {
    const projected = projectToolResult("s1", { toolUseId: "t1", content }, "mcp__playwright__browser_take_screenshot");
    const parsed = parseContentForImages(projected.content);

    expect(parsed).not.toBeNull();
    expect(parsed!.text).toBe("Screenshot captured");
    expect(parsed!.images).toHaveLength(1);
    expect(parsed!.images[0]!.src).toBe(imageUrl("s1", imageHash(png)));
    expect(parsed!.images[0]!.mediaType).toBe("image/png");
    // The render path prefers `src`, but `data` must be genuinely gone rather
    // than merely unused — the whole point is that it left the wire.
    expect(parsed!.images[0]!.data).toBeUndefined();
  });

  it("parses the same way before and after projection, apart from the payload", () => {
    const before = parseContentForImages(content);
    const after = parseContentForImages(projectToolResult("s1", { toolUseId: "t1", content }, "X").content);
    expect(after!.text).toBe(before!.text);
    expect(after!.images).toHaveLength(before!.images.length);
  });
});

describe("the constraint consumers still resolve from a projected result (req 4)", () => {
  /**
   * Req 4 names four consumers that must keep working: AskUserQuestion reading
   * the answer out of result content, ExitPlanMode keying off result existence,
   * Present extracting its artifact id, and the subagent final report. The
   * first three read short values, so the guarantee is that the projection
   * leaves them *untouched* — asserted by reference equality, which is the
   * strongest form of "nothing happened to this".
   */
  const untouched = (content: string, toolName: string) => {
    const result = { toolUseId: "t1", content };
    expect(projectToolResult("s1", result, toolName)).toBe(result);
  };

  it("leaves an AskUserQuestion answer byte-identical", () => {
    untouched("Postgres", "AskUserQuestion");
  });

  it("leaves an ExitPlanMode result present and intact", () => {
    // The consumer only reads `!!result`, so what must survive is the entry
    // itself — a projection that dropped empty results would silently unresolve
    // every plan on reload.
    const result: ToolResultBlock = { toolUseId: "t1", content: "" };
    expect(projectToolResult("s1", result, "ExitPlanMode")).toBe(result);
  });

  it("leaves a Present payload parseable by the real parser", () => {
    const content = JSON.stringify([
      { type: "text", text: JSON.stringify({ presentId: "pres_abc123", title: "Mockup" }) },
    ]);
    untouched(content, "mcp__shipit__present");

    const tool = { type: "tool_use", id: "t1", name: "mcp__shipit__present", input: {} } as unknown as ToolUseBlock;
    const projected = projectToolResult("s1", { toolUseId: "t1", content }, "mcp__shipit__present");
    expect(parsePresentToolResult(tool, projected as ToolResultBlock)).toEqual({
      presentId: "pres_abc123",
      title: "Mockup",
    });
  });

  it("leaves a subagent final report whole even when it is enormous", () => {
    // The one body with no expand affordance anywhere: `SubagentCall` renders
    // it as markdown in full, so a slice here would cut a report with no way
    // to get the rest back.
    const report = Array.from({ length: 5_000 }, (_, i) => `finding ${i}`).join("\n");
    for (const parent of ["Task", "Agent"]) {
      const projected = projectToolResult("s1", { toolUseId: "t1", content: report }, parent);
      expect(projected.content).toBe(report);
      expect(projected.truncated).toBeUndefined();
    }
  });
});

describe("diff stats survive the body being stripped", () => {
  /**
   * Once the file body is off the wire, `DiffBlock` draws `+N -M` from the
   * server's stats instead of recomputing them. The two `countLines`
   * implementations are separate functions in separate layers, so this pins
   * them together — if either drifts, the summary silently changes on reload.
   */
  const cases: { name: string; input: Record<string, unknown> }[] = [
    { name: "Write", input: { file_path: "/a.ts", content: "a\nb\nc" } },
    { name: "Edit", input: { file_path: "/a.ts", old_string: "x\ny", new_string: "x\ny\nz\nw" } },
    { name: "Write", input: { file_path: "/a.ts", content: "trailing newline\n" } },
    { name: "Edit", input: { file_path: "/a.ts", old_string: "only-old", new_string: "" } },
  ];

  for (const { name, input } of cases) {
    it(`${name} ${JSON.stringify(input).slice(0, 48)}… matches the client's countLines`, () => {
      const projected = projectToolUse({ name, input });

      expect(projected.diffStats).toEqual({
        added: countLines((input.new_string ?? input.content ?? "") as string),
        removed: countLines((input.old_string ?? "") as string),
      });
      // …and the body it computed them from is gone.
      expect(projected.bodyTruncated).toBe(true);
      for (const key of ["content", "old_string", "new_string"]) {
        expect(projected.input[key]).toBeUndefined();
      }
      // The path stays: it is what the one-line summary draws.
      expect(projected.input.file_path).toBe("/a.ts");
    });
  }

  it("leaves a body-less Edit alone rather than stamping empty stats on it", () => {
    const tool = { name: "Edit", input: { file_path: "/a.ts" } };
    expect(projectToolUse(tool)).toBe(tool);
  });
});
