/**
 * Grok Build tool name → canonical tool name mapping. Per-agent slice of the
 * merged table in `../tool-map.ts`. See docs/155 hair 12.
 *
 * Grok tool ids are lower_snake_case; the set was read off the `system`/`init`
 * event of real headless turns (CLI 1.0.1, docs/274) and matches
 * `GROK_TOOL_NAMES`.
 *
 * Six of the CLI's twenty-five advertised tools are deliberately unmapped, and
 * the omission is the honest answer rather than a gap: `image_gen`,
 * `image_edit`, `image_to_video` and `reference_to_video` are media-generation
 * tools with no canonical equivalent (`image_view` is Codex's tool for LOOKING
 * at one, which is the opposite operation), and `use_tool` /
 * `get_command_or_subagent_output` / `kill_command_or_subagent` are
 * meta-operations on other calls rather than calls of their own. An unmapped
 * name renders under its raw id, which is the correct outcome for a tool the
 * transcript has no dedicated treatment for.
 */

import type { CanonicalTool } from "../tool-map.js";

export const GROK_TOOL_MAP: Record<string, CanonicalTool> = {
  run_terminal_command: "shell",
  read_file: "file_read",
  write: "file_write",
  // Grok's editor is a find-and-replace, so it is an EDIT rather than a write:
  // the transcript's diff surfaces key off this distinction (docs/272).
  search_replace: "file_edit",
  list_dir: "glob",
  grep: "grep",
  todo_write: "todo",
  spawn_subagent: "agent",
  web_search: "web_search",
  ask_user_question: "ask_user",
  enter_plan_mode: "plan",
  exit_plan_mode: "plan",
  monitor: "monitor",
  workflow: "workflow",
  search_tool: "tool_search",
  scheduler_create: "schedule",
  scheduler_delete: "schedule",
  scheduler_list: "schedule",
};
