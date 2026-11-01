import { describe, it, expect } from "vitest";
import { OPENCODE2_TOOL_NAMES } from "../../../shared/agent-tool-names.js";
import {
  OPENCODE2_TRANSCRIPT_TOOL_NAMES,
  normalizeOpencode2ToolCall,
  normalizeOpencode2ToolResult,
} from "./opencode2-tool-normalizer.js";

describe("OpenCode 2 tool normalizer", () => {
  it("names every tool a turn can call", () => {
    expect(Object.keys(OPENCODE2_TRANSCRIPT_TOOL_NAMES).sort()).toEqual([...OPENCODE2_TOOL_NAMES].sort());
  });

  it("maps 2.1.1's renamed tools and their `path` argument", () => {
    expect(normalizeOpencode2ToolCall("shell", { command: "ls", timeout: 0 })).toEqual({ name: "Bash", input: { command: "ls", timeout: 0 } });
    expect(normalizeOpencode2ToolCall("edit", { path: "/a.ts", oldString: "x", newString: "y", replaceAll: true }))
      .toEqual({ name: "Edit", input: { file_path: "/a.ts", old_string: "x", new_string: "y", replace_all: true } });
    expect(normalizeOpencode2ToolCall("read", { path: "/a.ts", offset: 1 })).toEqual({ name: "Read", input: { file_path: "/a.ts", offset: 1 } });
    expect(normalizeOpencode2ToolCall("write", { path: "/a.ts", content: "c" })).toEqual({ name: "Write", input: { file_path: "/a.ts", content: "c" } });
    expect(normalizeOpencode2ToolCall("skill", { id: "deploy" })).toEqual({ name: "Skill", input: { skill: "deploy" } });
    expect(normalizeOpencode2ToolCall("subagent", { agent: "general", description: "d", prompt: "p" }))
      .toEqual({ name: "Agent", input: { subagent_type: "general", description: "d", prompt: "p" } });
  });

  it("keeps a directory `path` on glob and grep", () => {
    expect(normalizeOpencode2ToolCall("grep", { pattern: "x", path: "src" })).toEqual({ name: "Grep", input: { pattern: "x", path: "src" } });
    expect(normalizeOpencode2ToolCall("glob", { pattern: "*.ts", path: "src" })).toEqual({ name: "Glob", input: { pattern: "*.ts", path: "src" } });
  });

  it("passes an unknown tool through, MCP tools included", () => {
    expect(normalizeOpencode2ToolCall("playwright_browser_click", { path: "x" })).toEqual({ name: "playwright_browser_click", input: { path: "x" } });
  });

  it("unwraps a completed subagent report and nothing else", () => {
    expect(normalizeOpencode2ToolResult("subagent", '<subagent sessionID="ses_1" state="completed">\n## Report\n<b>kept</b>\n</subagent>'))
      .toBe("## Report\n<b>kept</b>");
    expect(normalizeOpencode2ToolResult("subagent", "failed: no model")).toBe("failed: no model");
    expect(normalizeOpencode2ToolResult("shell", "<subagent>x</subagent>")).toBe("<subagent>x</subagent>");
  });
});
