import { describe, it, expect } from "vitest";
import { canonicalizeTool, agentToolName } from "./tool-map.js";

describe("canonicalizeTool", () => {
  it("maps Claude CLI tool names to canonical names", () => {
    expect(canonicalizeTool("claude", "Read")).toBe("file_read");
    expect(canonicalizeTool("claude", "Write")).toBe("file_write");
    expect(canonicalizeTool("claude", "Edit")).toBe("file_edit");
    expect(canonicalizeTool("claude", "Bash")).toBe("shell");
    expect(canonicalizeTool("claude", "Glob")).toBe("glob");
    expect(canonicalizeTool("claude", "Grep")).toBe("grep");
    expect(canonicalizeTool("claude", "WebFetch")).toBe("web_fetch");
    expect(canonicalizeTool("claude", "WebSearch")).toBe("web_search");
    expect(canonicalizeTool("claude", "AskUserQuestion")).toBe("ask_user");
  });

  it("maps Codex CLI tool names to canonical names", () => {
    expect(canonicalizeTool("codex", "shell")).toBe("shell");
    expect(canonicalizeTool("codex", "command")).toBe("shell");
    expect(canonicalizeTool("codex", "file_write")).toBe("file_write");
    expect(canonicalizeTool("codex", "file_read")).toBe("file_read");
    expect(canonicalizeTool("codex", "file_edit")).toBe("file_edit");
    expect(canonicalizeTool("codex", "apply_diff")).toBe("file_edit");
    expect(canonicalizeTool("codex", "apply_patch")).toBe("file_edit");
  });

  it("maps MCP Playwright browser tool names to browser", () => {
    expect(canonicalizeTool("claude", "mcp__playwright__browser_navigate")).toBe("browser");
    expect(canonicalizeTool("claude", "mcp__playwright__browser_snapshot")).toBe("browser");
    expect(canonicalizeTool("claude", "mcp__playwright__browser_click")).toBe("browser");
    expect(canonicalizeTool("claude", "mcp__playwright__browser_type")).toBe("browser");
    expect(canonicalizeTool("claude", "mcp__playwright__browser_take_screenshot")).toBe("browser");
    expect(canonicalizeTool("claude", "mcp__playwright__browser_scroll")).toBe("browser");
    expect(canonicalizeTool("claude", "mcp__playwright__browser_hover")).toBe("browser");
    expect(canonicalizeTool("claude", "mcp__playwright__browser_select_option")).toBe("browser");
  });

  it("returns null for unknown tool names", () => {
    expect(canonicalizeTool("claude", "UnknownTool")).toBeNull();
    expect(canonicalizeTool("codex", "UnknownTool")).toBeNull();
  });
});

describe("agentToolName", () => {
  it("reverse-maps canonical names to Claude CLI tool names", () => {
    expect(agentToolName("claude", "file_read")).toBe("Read");
    expect(agentToolName("claude", "file_write")).toBe("Write");
    expect(agentToolName("claude", "file_edit")).toBe("Edit");
    expect(agentToolName("claude", "shell")).toBe("Bash");
    expect(agentToolName("claude", "ask_user")).toBe("AskUserQuestion");
  });

  it("reverse-maps canonical names to Codex CLI tool names", () => {
    expect(agentToolName("codex", "shell")).toBe("shell");
    expect(agentToolName("codex", "file_write")).toBe("file_write");
    expect(agentToolName("codex", "file_read")).toBe("file_read");
    expect(agentToolName("codex", "file_edit")).toBe("file_edit");
  });

  it("returns null for unmapped canonical names", () => {
    expect(agentToolName("codex", "web_fetch")).toBeNull();
  });
});
