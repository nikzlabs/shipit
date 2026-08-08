import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { restoreFullResolutionScreenshots, MAX_SCREENSHOT_BYTES } from "./playwright-screenshot.js";
import { PLAYWRIGHT_OUTPUT_DIR } from "./agents/playwright-mcp.js";
import type { AgentEvent } from "../shared/types.js";

/**
 * The module reads from the real {@link PLAYWRIGHT_OUTPUT_DIR} — that constant
 * is the whole traversal defence, so parameterising it for the test would test
 * a different function. `/tmp/.playwright-mcp` is writable in the worker
 * container and in CI, and each test cleans up only the file it wrote.
 */
function writeCapture(name: string, bytes: Buffer): string {
  fs.mkdirSync(PLAYWRIGHT_OUTPUT_DIR, { recursive: true });
  const file = path.join(PLAYWRIGHT_OUTPUT_DIR, name);
  fs.writeFileSync(file, bytes);
  return file;
}

/** The real reply shape: a markdown link to the file, then the shrunk image. */
function screenshotEvent(link: string, imageBase64: string): AgentEvent {
  return {
    type: "agent_tool_result",
    content: [{
      type: "tool_result",
      tool_use_id: "toolu_shot",
      content: [
        { type: "text", text: `### Result\n- [Screenshot of viewport](${link})\n### Ran Playwright code` },
        { type: "image", source: { type: "base64", media_type: "image/png", data: imageBase64 } },
      ],
    }],
  } as AgentEvent;
}

function imageBlockOf(event: AgentEvent): Record<string, unknown> {
  const results = (event as { content: Record<string, unknown>[] }).content;
  const inner = results[0]!.content as Record<string, unknown>[];
  return inner.find((b) => b.type === "image")!.source as Record<string, unknown>;
}

const written: string[] = [];
beforeEach(() => { written.length = 0; });
afterEach(() => { for (const f of written) fs.rmSync(f, { force: true }); });

function capture(name: string, bytes: Buffer): void {
  written.push(writeCapture(name, bytes));
}

describe("restoreFullResolutionScreenshots", () => {
  it("swaps in the full-resolution file the MCP shrank out of its reply", () => {
    // Measured against @playwright/mcp 0.0.78: a full-page 1280x2536 capture is
    // written to disk whole and delivered to the model at 780x1545 — and the
    // shrunk copy is BIGGER, because bicubic resampling turns a UI's flat colour
    // runs into gradients PNG can't compress.
    const full = Buffer.from("the-real-1280x2536-capture-on-disk-with-every-pixel");
    capture("page-2026-01-01T00-00-00-000Z.png", full);
    const shrunk = Buffer.from("shrunk-780x1545").toString("base64");

    const out = restoreFullResolutionScreenshots(
      screenshotEvent("../tmp/.playwright-mcp/page-2026-01-01T00-00-00-000Z.png", shrunk),
    );

    expect(imageBlockOf(out).data).toBe(full.toString("base64"));
    expect(imageBlockOf(out).media_type).toBe("image/png");
  });

  it("resolves the link by basename, so a traversal in tool output goes nowhere", () => {
    // The link is tool output, and tool output is attacker-influenceable. Only
    // the basename is used, so `../../etc/passwd` can only ever name a file
    // inside the output dir.
    const full = Buffer.from("real-capture");
    capture("evil.png", full);
    const shrunk = Buffer.from("shrunk").toString("base64");

    const out = restoreFullResolutionScreenshots(
      screenshotEvent("../../../../etc/evil.png", shrunk),
    );

    // It found OUR file in the output dir, not anything up the tree.
    expect(imageBlockOf(out).data).toBe(full.toString("base64"));
  });

  it("leaves the event untouched when the sizes match — the cap never fired", () => {
    // A viewport screenshot is under 1.15 megapixels, so the MCP ships it whole
    // and the file is byte-identical. Substituting would burn a read and a
    // base64 encode on every screenshot to produce the same bytes.
    const bytes = Buffer.from("identical-viewport-capture");
    capture("page-same.png", bytes);
    const event = screenshotEvent("../tmp/.playwright-mcp/page-same.png", bytes.toString("base64"));

    expect(restoreFullResolutionScreenshots(event)).toBe(event);
  });

  it("keeps the shrunk image when the file is gone", () => {
    // `--output-max-size` evicts old output. A degraded screenshot beats none.
    const shrunk = Buffer.from("shrunk").toString("base64");
    const event = screenshotEvent("../tmp/.playwright-mcp/page-evicted.png", shrunk);

    expect(restoreFullResolutionScreenshots(event)).toBe(event);
    expect(imageBlockOf(event).data).toBe(shrunk);
  });

  it("refuses a file over the size ceiling", () => {
    const huge = Buffer.alloc(MAX_SCREENSHOT_BYTES + 1, 1);
    capture("page-huge.png", huge);
    const event = screenshotEvent("../tmp/.playwright-mcp/page-huge.png", Buffer.from("s").toString("base64"));

    expect(restoreFullResolutionScreenshots(event)).toBe(event);
  });

  it("does nothing for a result with a link but no image block", () => {
    // What a `filename` screenshot looks like: the MCP returns the link alone
    // and registers no image, so there is nothing to substitute.
    capture("page-named.png", Buffer.from("on-disk"));
    const event = {
      type: "agent_tool_result",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_named",
        content: [{ type: "text", text: "- [Screenshot](../tmp/.playwright-mcp/page-named.png)" }],
      }],
    } as AgentEvent;

    expect(restoreFullResolutionScreenshots(event)).toBe(event);
  });

  it("does nothing for an image result that links no file", () => {
    const event = {
      type: "agent_tool_result",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_other",
        content: [
          { type: "text", text: "some MCP tool that returns a chart" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
        ],
      }],
    } as AgentEvent;

    expect(restoreFullResolutionScreenshots(event)).toBe(event);
  });

  it("passes every non-tool-result event straight through", () => {
    const event = { type: "agent_assistant", content: [{ type: "text", text: "hi" }] } as AgentEvent;
    expect(restoreFullResolutionScreenshots(event)).toBe(event);
  });

  it("does not mutate the event it was given", () => {
    // The caller broadcasts the returned copy; the original keeps flowing to
    // whatever else reads it, and must not have been rewritten underneath.
    capture("page-copy.png", Buffer.from("full-resolution-bytes"));
    const shrunk = Buffer.from("shrunk").toString("base64");
    const event = screenshotEvent("../tmp/.playwright-mcp/page-copy.png", shrunk);

    const out = restoreFullResolutionScreenshots(event);

    expect(out).not.toBe(event);
    expect(imageBlockOf(event).data).toBe(shrunk);
  });
});
