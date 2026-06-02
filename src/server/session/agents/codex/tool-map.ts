/**
 * Codex CLI tool name → canonical tool name mapping. Per-agent slice of the
 * merged table in `../tool-map.ts`. See docs/155 hair 12.
 */

import type { CanonicalTool } from "../tool-map.js";

export const CODEX_TOOL_MAP: Record<string, CanonicalTool> = {
  shell: "shell",
  command: "shell",
  file_write: "file_write",
  file_read: "file_read",
  file_edit: "file_edit",
  apply_diff: "file_edit",
  apply_patch: "file_edit",
  // docs/147 — the ShipIt-managed ask bridge surfaces as an `AskUserQuestion`
  // tool_use (see adapter.handleItem); canonicalize it like Claude's so
  // activity labels render consistently.
  AskUserQuestion: "ask_user",
};
