/**
 * Codex CLI tool name → canonical tool name mapping. Per-agent slice of the
 * merged table in `../tool-map.ts`. See docs/155 hair 12.
 */

import type { CanonicalTool } from "../tool-map.js";

export const CODEX_TOOL_MAP: Record<string, CanonicalTool> = {
  shell: "shell",
  commandExecution: "shell",
  fileChange: "file_edit",
  apply_patch: "file_edit",
  web_search: "web_search",
  webSearch: "web_search",
  view_image: "image_view",
  imageView: "image_view",
  Agent: "agent",
  spawn_agent: "agent",
  spawnAgent: "agent",
  collabToolCall: "agent",
  collabAgentToolCall: "agent",
  // Collab lifecycle beyond the spawn: the event handler passes any collab
  // item's tool name through (`item.tool ?? "collab"`), and a real 0.147.0
  // turn emits these two (docs/272 codex run, 2026-08-17).
  wait: "agent",
  closeAgent: "agent",
  mcpToolCall: "mcp",
  dynamicToolCall: "mcp",
  tool_search: "tool_search",
  ToolSearch: "tool_search",
  // docs/147 — the ShipIt-managed ask bridge surfaces as an `AskUserQuestion`
  // tool_use (see adapter.handleItem); canonicalize it like Claude's so
  // activity labels render consistently.
  AskUserQuestion: "ask_user",
};
