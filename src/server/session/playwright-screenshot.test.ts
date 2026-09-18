import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { restoreFullResolutionScreenshots, MAX_SCREENSHOT_BYTES } from "./playwright-screenshot.js";
import { PLAYWRIGHT_OUTPUT_DIR } from "./agents/playwright-mcp.js";
import type { AgentEvent } from "../shared/types.js";

// Unique names avoid overwriting captures from the live MCP or other test workers.
let uid = 0;
const written: string[] = [];

function uniqueName(ext = ".png"): string {
  return `shipit-test-${process.pid}-${++uid}${ext}`;
}

function capture(bytes: Buffer, ext = ".png"): string {
  fs.mkdirSync(PLAYWRIGHT_OUTPUT_DIR, { recursive: true });
  const name = uniqueName(ext);
  fs.writeFileSync(path.join(PLAYWRIGHT_OUTPUT_DIR, name), bytes);
  written.push(name);
  return name;
}

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

function mcpLink(name: string): string {
  return `../tmp/.playwright-mcp/${name}`;
}

function imageSourceOf(event: AgentEvent): Record<string, unknown> {
  const results = (event as { content: Record<string, unknown>[] }).content;
  const inner = results[0]!.content as Record<string, unknown>[];
  return inner.find((b) => b.type === "image")!.source as Record<string, unknown>;
}

beforeEach(() => { written.length = 0; });
afterEach(() => {
  for (const name of written) fs.rmSync(path.join(PLAYWRIGHT_OUTPUT_DIR, name), { force: true });
});

describe("restoreFullResolutionScreenshots", () => {
  it("swaps in the full-resolution file the MCP shrank out of its reply", () => {
    const full = Buffer.from("the-real-1280x2536-capture-with-every-pixel");
    const name = capture(full);
    const shrunk = Buffer.from("shrunk-780x1545").toString("base64");

    const out = restoreFullResolutionScreenshots(screenshotEvent(mcpLink(name), shrunk));

    expect(imageSourceOf(out).data).toBe(full.toString("base64"));
    expect(imageSourceOf(out).media_type).toBe("image/png");
  });

  it("resolves by basename, so a traversal in tool output goes nowhere", () => {
    const full = Buffer.from("real-capture-in-the-output-dir");
    const name = capture(full);
    const shrunk = Buffer.from("shrunk").toString("base64");

    const out = restoreFullResolutionScreenshots(
      screenshotEvent(`../../../../etc/.playwright-mcp/${name}`, shrunk),
    );

    expect(imageSourceOf(out).data).toBe(full.toString("base64"));
  });

  it("refuses to follow a symlink planted in the output dir", () => {
    const secret = path.join(PLAYWRIGHT_OUTPUT_DIR, uniqueName(".secret"));
    fs.writeFileSync(secret, "not-a-screenshot");
    written.push(path.basename(secret));
    const linkName = uniqueName();
    fs.symlinkSync(secret, path.join(PLAYWRIGHT_OUTPUT_DIR, linkName));
    written.push(linkName);

    const shrunk = Buffer.from("shrunk").toString("base64");
    const event = screenshotEvent(mcpLink(linkName), shrunk);

    expect(restoreFullResolutionScreenshots(event)).toBe(event);
    expect(imageSourceOf(event).data).toBe(shrunk);
  });

  it("leaves the event untouched when the file IS the block — the cap never fired", () => {
    const bytes = Buffer.from("identical-viewport-capture");
    const name = capture(bytes);
    const event = screenshotEvent(mcpLink(name), bytes.toString("base64"));

    expect(restoreFullResolutionScreenshots(event)).toBe(event);
  });

  it("substitutes a same-length but different image", () => {
    const full = Buffer.from("AAAAAAAAAAAAAAAAAAAAAAAA");
    const shrunkBytes = Buffer.from("BBBBBBBBBBBBBBBBBBBBBBBB");
    expect(full.length).toBe(shrunkBytes.length);
    const name = capture(full);

    const out = restoreFullResolutionScreenshots(
      screenshotEvent(mcpLink(name), shrunkBytes.toString("base64")),
    );

    expect(imageSourceOf(out).data).toBe(full.toString("base64"));
  });

  it("keeps the shrunk image when the file is gone", () => {
    const shrunk = Buffer.from("shrunk").toString("base64");
    const event = screenshotEvent(mcpLink("shipit-test-never-written.png"), shrunk);

    expect(restoreFullResolutionScreenshots(event)).toBe(event);
    expect(imageSourceOf(event).data).toBe(shrunk);
  });

  it("refuses a file over the size ceiling", () => {
    const name = capture(Buffer.alloc(MAX_SCREENSHOT_BYTES + 1, 1));
    const event = screenshotEvent(mcpLink(name), Buffer.from("s").toString("base64"));

    expect(restoreFullResolutionScreenshots(event)).toBe(event);
  });

  it("ignores a link that does not name the Playwright output directory", () => {
    const name = capture(Buffer.from("unrelated-but-same-name"));
    const shrunk = Buffer.from("some-other-tools-chart").toString("base64");
    const event = screenshotEvent(`./charts/${name}`, shrunk);

    expect(restoreFullResolutionScreenshots(event)).toBe(event);
  });

  it("does nothing for a result with a link but no image block", () => {
    const name = capture(Buffer.from("on-disk"));
    const event = {
      type: "agent_tool_result",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_named",
        content: [{ type: "text", text: `- [Screenshot](${mcpLink(name)})` }],
      }],
    } as AgentEvent;

    expect(restoreFullResolutionScreenshots(event)).toBe(event);
  });

  it("passes through Codex's string-valued tool result", () => {
    const event = {
      type: "agent_tool_result",
      content: [{ type: "tool_result", tool_use_id: "call_1", content: "### Result\n- [Screenshot](../tmp/.playwright-mcp/x.png)" }],
    } as AgentEvent;

    expect(restoreFullResolutionScreenshots(event)).toBe(event);
  });

  it("passes every non-tool-result event straight through", () => {
    const event = { type: "agent_assistant", content: [{ type: "text", text: "hi" }] } as AgentEvent;
    expect(restoreFullResolutionScreenshots(event)).toBe(event);
  });

  it("does not mutate the event it was given", () => {
    const name = capture(Buffer.from("full-resolution-bytes-on-disk"));
    const shrunk = Buffer.from("shrunk").toString("base64");
    const event = screenshotEvent(mcpLink(name), shrunk);
    const frozen = JSON.stringify(event);

    const out = restoreFullResolutionScreenshots(event);

    expect(out).not.toBe(event);
    expect(JSON.stringify(event)).toBe(frozen);
  });
});
