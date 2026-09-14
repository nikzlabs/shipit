import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_TRANSCRIPT_TOOL_NAMES,
  antigravityMcpLabel,
  normalizeAntigravityToolCall,
} from "./antigravity-tool-normalizer.js";
import { ANTIGRAVITY_TOOL_NAMES } from "../../../shared/agent-tool-names.js";

const PROBES = path.join(
  new URL("../../../../../docs/301-antigravity-harness/probes/", import.meta.url).pathname,
);

/**
 * The docs/272 Layer B checker: every tool name a CAPTURE carries must be one
 * the registry declares. Comparing the two constants to each other cannot catch
 * a name that only ever appears in a captured event, which is the drift a CLI
 * version bump actually produces.
 */
function undeclaredToolNamesIn(capture: string): string[] {
  const observed = new Set<string>();
  for (const line of capture.split("\n")) {
    if (!line.trim()) continue;
    const name = (JSON.parse(line) as { step_update?: { tool_name?: string } })
      .step_update?.tool_name;
    if (name) observed.add(name);
  }
  return [...observed].filter((n) => !(ANTIGRAVITY_TOOL_NAMES as readonly string[]).includes(n));
}

describe("the Antigravity tool vocabulary", () => {
  it("only maps names the CLI actually offers", () => {
    for (const name of Object.keys(ANTIGRAVITY_TRANSCRIPT_TOOL_NAMES)) {
      expect(ANTIGRAVITY_TOOL_NAMES as readonly string[], `${name} is not a CLI tool`).toContain(name);
    }
  });

  it("declares every tool name the captured tour actually used", () => {
    const capture = fs.readFileSync(path.join(PROBES, "tour2.ndjson"), "utf8");
    expect(undeclaredToolNamesIn(capture)).toEqual([]);
  });

  /**
   * The recipe's negative control (docs/272 Step 2): a checker that cannot go
   * red is worth nothing. Feed the same bytes with one name swapped for a
   * fabricated one and the check above must fail.
   */
  it("flags a fabricated tool name in a capture", () => {
    const capture = fs
      .readFileSync(path.join(PROBES, "tour2.ndjson"), "utf8")
      .replaceAll('"grep_search"', '"TaskCreateV2"');
    expect(undeclaredToolNamesIn(capture)).toEqual(["TaskCreateV2"]);
  });

  /**
   * The content keys are as load-bearing as the paths: a Write card with a
   * `file_path` and no `content`, or an Edit card with no `old_string` /
   * `new_string`, renders as an empty box — the card looks right and the diff is
   * simply gone.
   */
  it("carries a write's body through to the card, not just its path", () => {
    expect(normalizeAntigravityToolCall("write_to_file", {
      TargetFile: "/workspace/a.ts", CodeContent: "export const a = 1;",
    })).toEqual({ name: "Write", input: { file_path: "/workspace/a.ts", content: "export const a = 1;" } });
  });

  /**
   * The two search tools spell their fields differently from each other, and the
   * first tour capture on 1.1.27 caught both: a Grep card whose path was dropped
   * and a Glob card with no pattern at all — the one thing each card is about.
   */
  it("renames the search fields each search tool actually sends", () => {
    expect(normalizeAntigravityToolCall("grep_search", {
      Query: "conversion-probe", SearchPath: "/workspace",
    })).toEqual({ name: "Grep", input: { pattern: "conversion-probe", path: "/workspace" } });
    expect(normalizeAntigravityToolCall("find_by_name", {
      Pattern: "package.json", SearchDirectory: "/workspace",
    })).toEqual({ name: "Glob", input: { pattern: "package.json", path: "/workspace" } });
  });

  it("carries an edit's before and after text, so the diff renders", () => {
    expect(normalizeAntigravityToolCall("replace_file_content", {
      AbsolutePath: "/workspace/a.ts", TargetContent: "old", ReplacementContent: "new",
    })).toEqual({
      name: "Edit",
      input: { file_path: "/workspace/a.ts", old_string: "old", new_string: "new" },
    });
  });

  /**
   * `manage_task` manages background PROCESSES, not a to-do list. Mapped to
   * TodoWrite it went to a task panel that rejects input without `todos`, and
   * whose rows the ordinary transcript hides — so killing a background task
   * produced no row at all.
   */
  it("leaves background-task management as itself", () => {
    expect(normalizeAntigravityToolCall("manage_task", { Action: "kill", TaskId: "t-1" }))
      .toEqual({ name: "manage_task", input: { Action: "kill", TaskId: "t-1" } });
  });

  it("labels an MCP call by its server and tool, and unwraps its arguments", () => {
    expect(normalizeAntigravityToolCall("call_mcp_tool", {
      ServerName: "shipit", ToolName: "present", Arguments: { file: "/a.html" },
    })).toEqual({ name: "mcp__shipit__present", input: { file: "/a.html" } });
  });

  it("keeps an MCP call renderable when the wrapper names nothing", () => {
    expect(antigravityMcpLabel({ Arguments: {} })).toBeUndefined();
    expect(normalizeAntigravityToolCall("call_mcp_tool", { Arguments: {} }).name).toBe("call_mcp_tool");
  });

  it("passes an unmapped tool through untouched", () => {
    expect(normalizeAntigravityToolCall("generate_image", { Prompt: "x" }))
      .toEqual({ name: "generate_image", input: { Prompt: "x" } });
  });
});
