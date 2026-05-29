/**
 * Claude CLI tool name → canonical tool name mapping. Per-agent slice of the
 * merged table in `../tool-map.ts`. See docs/155 hair 12.
 */

import type { CanonicalTool } from "../tool-map.js";

export const CLAUDE_TOOL_MAP: Record<string, CanonicalTool> = {
  Read: "file_read",
  Write: "file_write",
  Edit: "file_edit",
  Bash: "shell",
  Glob: "glob",
  Grep: "grep",
  WebFetch: "web_fetch",
  WebSearch: "web_search",
  AskUserQuestion: "ask_user",
  // MCP browser tools (prefixed by CLI)
  "mcp__playwright__browser_navigate": "browser",
  "mcp__playwright__browser_snapshot": "browser",
  "mcp__playwright__browser_click": "browser",
  "mcp__playwright__browser_type": "browser",
  "mcp__playwright__browser_take_screenshot": "browser",
  "mcp__playwright__browser_scroll": "browser",
  "mcp__playwright__browser_hover": "browser",
  "mcp__playwright__browser_select_option": "browser",
};
