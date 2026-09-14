import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_TRANSCRIPT_TOOL_NAMES,
  ANTIGRAVITY_UNNORMALIZED_INTERACTIVE_TOOLS,
  antigravityMcpLabel,
  normalizeAntigravityToolCall,
} from "./antigravity-tool-normalizer.js";
import { ANTIGRAVITY_TOOL_NAMES } from "../../../shared/agent-tool-names.js";

const PROBES = path.join(
  new URL("../../../../../docs/301-antigravity-harness/probes/", import.meta.url).pathname,
);

/**
 * Names that arrive and are deliberately left to render as themselves — the
 * record of a decision, so that "no dedicated treatment" and "we chose none"
 * stay distinguishable. `manage_task` manages background processes rather than a
 * to-do list; the interactive tools' input shapes have never been observed.
 */
const RENDERED_AS_THEMSELVES = new Set([
  "manage_task",
  ...ANTIGRAVITY_UNNORMALIZED_INTERACTIVE_TOOLS,
]);

function toolNamesIn(capture: string): string[] {
  const observed = new Set<string>();
  for (const line of capture.split("\n")) {
    if (!line.trim()) continue;
    const name = (JSON.parse(line) as { step_update?: { tool_name?: string } })
      .step_update?.tool_name;
    if (name) observed.add(name);
  }
  return [...observed];
}

/**
 * The docs/272 Layer B checker, first half: every tool name a CAPTURE carries
 * must be one the registry declares. Comparing the two constants to each other
 * cannot catch a name that only ever appears in a captured event, which is the
 * drift a CLI version bump actually produces.
 */
function undeclaredToolNamesIn(capture: string): string[] {
  return toolNamesIn(capture)
    .filter((n) => !(ANTIGRAVITY_TOOL_NAMES as readonly string[]).includes(n));
}

/**
 * Second half, and the one the recipe is really about (planning#337: Claude's
 * task panel degraded silently for weeks). Declaring a name is not treating it —
 * a name added to the registry and to nothing else renders as a raw tool name.
 * So a captured name must ALSO reach a transcript card, an MCP label, or the
 * explicit decision above.
 */
function untreatedToolNamesIn(capture: string): string[] {
  return toolNamesIn(capture).filter((n) =>
    !(n in ANTIGRAVITY_TRANSCRIPT_TOOL_NAMES)
    && n !== "call_mcp_tool"
    && !RENDERED_AS_THEMSELVES.has(n));
}

describe("the Antigravity tool vocabulary", () => {
  it("only maps names the CLI actually offers", () => {
    for (const name of Object.keys(ANTIGRAVITY_TRANSCRIPT_TOOL_NAMES)) {
      expect(ANTIGRAVITY_TOOL_NAMES as readonly string[], `${name} is not a CLI tool`).toContain(name);
    }
  });

  it("declares and treats every tool name the captured tour actually used", () => {
    const capture = fs.readFileSync(path.join(PROBES, "tour2.ndjson"), "utf8");
    // An empty capture would satisfy both filters without checking anything.
    expect(toolNamesIn(capture).length).toBeGreaterThan(5);
    expect(undeclaredToolNamesIn(capture)).toEqual([]);
    expect(untreatedToolNamesIn(capture)).toEqual([]);
  });

  /**
   * The recipe's negative control (docs/272 Step 2), which asks for BOTH halves:
   * the fabricated name is flagged as undeclared, and — the failure class the
   * recipe exists for — adding it to the registry does not silence the second
   * check, because declaring a name is not the same as rendering it.
   */
  it("flags a fabricated tool name in a capture, and still flags it once declared", () => {
    const capture = fs
      .readFileSync(path.join(PROBES, "tour2.ndjson"), "utf8")
      .replaceAll('"grep_search"', '"TaskCreateV2"');
    expect(undeclaredToolNamesIn(capture)).toEqual(["TaskCreateV2"]);
    expect(untreatedToolNamesIn(capture)).toEqual(["TaskCreateV2"]);
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
