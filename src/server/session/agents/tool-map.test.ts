import { describe, it, expect } from "vitest";
import { canonicalizeTool, agentToolName } from "./tool-map.js";

describe("canonicalizeTool", () => {
  it("maps Claude CLI tool names to canonical names", () => {
    expect(canonicalizeTool("claude", "Agent")).toBe("agent");
    expect(canonicalizeTool("claude", "Read")).toBe("file_read");
    expect(canonicalizeTool("claude", "Write")).toBe("file_write");
    expect(canonicalizeTool("claude", "Edit")).toBe("file_edit");
    expect(canonicalizeTool("claude", "Bash")).toBe("shell");
    expect(canonicalizeTool("claude", "PowerShell")).toBe("shell");
    expect(canonicalizeTool("claude", "Glob")).toBe("glob");
    expect(canonicalizeTool("claude", "Grep")).toBe("grep");
    expect(canonicalizeTool("claude", "LSP")).toBe("lsp");
    expect(canonicalizeTool("claude", "Monitor")).toBe("monitor");
    expect(canonicalizeTool("claude", "NotebookEdit")).toBe("notebook_edit");
    expect(canonicalizeTool("claude", "WebFetch")).toBe("web_fetch");
    expect(canonicalizeTool("claude", "WebSearch")).toBe("web_search");
    expect(canonicalizeTool("claude", "AskUserQuestion")).toBe("ask_user");
    expect(canonicalizeTool("claude", "CronCreate")).toBe("schedule");
    expect(canonicalizeTool("claude", "EnterPlanMode")).toBe("plan");
    expect(canonicalizeTool("claude", "ExitPlanMode")).toBe("plan");
    expect(canonicalizeTool("claude", "EnterWorktree")).toBe("worktree");
    expect(canonicalizeTool("claude", "ListMcpResourcesTool")).toBe("mcp");
    expect(canonicalizeTool("claude", "ReadMcpResourceTool")).toBe("mcp");
    expect(canonicalizeTool("claude", "PushNotification")).toBe("notification");
    expect(canonicalizeTool("claude", "Skill")).toBe("skill");
    expect(canonicalizeTool("claude", "TaskCreate")).toBe("task");
    expect(canonicalizeTool("claude", "TodoWrite")).toBe("todo");
    expect(canonicalizeTool("claude", "ToolSearch")).toBe("tool_search");
    expect(canonicalizeTool("claude", "Workflow")).toBe("workflow");
  });

  it("maps Codex CLI tool names to canonical names", () => {
    expect(canonicalizeTool("codex", "shell")).toBe("shell");
    expect(canonicalizeTool("codex", "commandExecution")).toBe("shell");
    expect(canonicalizeTool("codex", "fileChange")).toBe("file_edit");
    expect(canonicalizeTool("codex", "apply_patch")).toBe("file_edit");
    expect(canonicalizeTool("codex", "mcpToolCall")).toBe("mcp");
    expect(canonicalizeTool("codex", "dynamicToolCall")).toBe("mcp");
    expect(canonicalizeTool("codex", "collabToolCall")).toBe("agent");
    expect(canonicalizeTool("codex", "spawn_agent")).toBe("agent");
    expect(canonicalizeTool("codex", "webSearch")).toBe("web_search");
    expect(canonicalizeTool("codex", "imageView")).toBe("image_view");
    expect(canonicalizeTool("codex", "tool_search")).toBe("tool_search");
    expect(canonicalizeTool("codex", "AskUserQuestion")).toBe("ask_user");
  });

  it("does not keep removed Codex compatibility aliases", () => {
    expect(canonicalizeTool("codex", "command")).toBeNull();
    expect(canonicalizeTool("codex", "file_write")).toBeNull();
    expect(canonicalizeTool("codex", "file_read")).toBeNull();
    expect(canonicalizeTool("codex", "file_edit")).toBeNull();
    expect(canonicalizeTool("codex", "apply_diff")).toBeNull();
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
    expect(agentToolName("codex", "file_edit")).toBe("fileChange");
    expect(agentToolName("codex", "agent")).toBe("Agent");
  });

  it("returns null for unmapped canonical names", () => {
    expect(agentToolName("codex", "file_read")).toBeNull();
  });
});
