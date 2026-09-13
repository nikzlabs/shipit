import { describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_TRANSCRIPT_TOOL_NAMES,
  antigravityMcpLabel,
  normalizeAntigravityToolCall,
} from "./antigravity-tool-normalizer.js";
import { ANTIGRAVITY_TOOL_NAMES } from "../../../shared/agent-tool-names.js";

describe("the Antigravity tool vocabulary", () => {
  it("only maps names the CLI actually offers", () => {
    for (const name of Object.keys(ANTIGRAVITY_TRANSCRIPT_TOOL_NAMES)) {
      expect(ANTIGRAVITY_TOOL_NAMES as readonly string[], `${name} is not a CLI tool`).toContain(name);
    }
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
