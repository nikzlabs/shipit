/**
 * OpenCode CLI tool name → canonical tool name mapping. Per-agent slice of the
 * merged table in `../tool-map.ts`. See docs/155 hair 12.
 *
 * OpenCode tool ids are lowercase; the set was verified against a live
 * `opencode run` turn (CLI 1.18.15, docs/268).
 */

import type { CanonicalTool } from "../tool-map.js";

export const OPENCODE_TOOL_MAP: Record<string, CanonicalTool> = {
  bash: "shell",
  edit: "file_edit",
  glob: "glob",
  grep: "grep",
  read: "file_read",
  write: "file_write",
  webfetch: "web_fetch",
  task: "agent",
  todowrite: "todo",
  skill: "skill",
};
