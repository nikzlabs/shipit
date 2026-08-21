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
 * meta-operations on other calls rather than calls of their own.
 *
 * Division of labor (planning#437): this map is the SEMANTIC ORACLE — the
 * cross-agent statement of what each wire name means — and nothing on the
 * production render path reads it. What the transcript actually persists and
 * renders is decided by `grok-tool-normalizer.ts`, which translates most of
 * these names (and two divergent input keys) into the Claude-spelled
 * vocabulary the recognition registries key on, at the adapter's Layer A
 * boundary; its guard tests hold the two tables coherent. A name the
 * normalizer leaves alone — the six unmapped ones above, plus the three
 * interactive tools it deliberately skips — renders under its raw id, the
 * correct outcome for a tool the transcript has no dedicated treatment for.
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
