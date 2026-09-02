/**
 * Pure tool-call normalization for the Grok adapter (planning#437, following
 * the planning#432 OpenCode precedent).
 *
 * Grok Build's wire speaks lower_snake_case tool ids (`todo_write`, `write`,
 * `search_replace`, `spawn_subagent`) with mostly Claude-spelled input keys —
 * the fixture captures show `file_path`, `old_string`, `new_string` already in
 * the registry vocabulary; only `read_file{target_file}` and
 * `list_dir{target_directory}` spell their path key differently. ShipIt's
 * recognition registries — the task panel, `DIFF_INPUT_TOOLS`, the subagent
 * card, `inputKeyTreatment`'s keep-lists — key on the transcript vocabulary,
 * which is Claude-spelled. An unrecognized name mostly degrades to a generic
 * row, but two registries *destroy display data* on a miss: `inputKeyTreatment`
 * defaults to `drop` (the docs/272 RED run showed `todo_write`'s `todos`
 * stripped off the wire, and the panel is the one surface with no fetch path
 * back), and `rendersResultContentInline` returns false for an unknown name (a
 * subagent's report body is sliced away).
 *
 * So the adapter translates at the Layer A boundary, exactly like the Codex and
 * OpenCode adapters (`codex-tool-normalizer.ts`, `opencode-tool-normalizer.ts`).
 * The persisted tool name is ShipIt's transcript vocabulary, not a raw wire
 * echo. Rows persisted before this normalizer existed keep their raw names —
 * history is never rewritten.
 *
 * The mapping is semantic, not cosmetic — each target was chosen against the
 * registry that renders it:
 *
 *   - `todo_write` → `TodoWrite`: Grok's to-do tool is DECLARATIVE (whole list
 *     in `todos`) — the fold's `TodoWrite` branch, not the incremental
 *     `TaskCreate` model. Its `merge: true` calls patch items by id; the fold
 *     (`client/components/task-list.ts`) understands that flag, which is why
 *     the whole input (`todos` + `merge`, item `id`s included) must survive the
 *     wire — guarded next door against `inputKeyTreatment`.
 *   - `spawn_subagent` → `Agent`: carries `description`/`prompt`/
 *     `subagent_type`, already the subagent key set. `Agent` rather than `Task`
 *     because `Agent` is the name the subagent registries recognize.
 *   - `search_replace` → `Edit`, `write` → `Write`: the bodies already use
 *     `DIFF_BODY_KEYS` spellings, so the rename alone makes `diffStatsFor` and
 *     the DiffBlock work unchanged.
 *   - `list_dir` → `Glob` is the loosest of the set, knowingly: Claude's `Glob`
 *     matches a pattern where Grok's tool enumerates one directory, so the
 *     transcript says "Glob" for a listing, because Claude's vocabulary has no
 *     directory-listing name to prefer.
 *
 * Three advertised tools with canonical mappings are DELIBERATELY not here:
 * `ask_user_question`, `enter_plan_mode`, `exit_plan_mode`. Their transcript
 * names (`AskUserQuestion`, `Enter`/`ExitPlanMode`) drive interactive cards
 * that render the *input* inline and return before the tool-call modal — and
 * Grok's input shapes for them are unobserved (the docs/272 captures are
 * headless; interactive rows are never driven). Mapping an unverified shape
 * onto a card that renders it inline could blank the row entirely, which is
 * strictly worse than a raw generic row. ShipIt's ask card is delivered through
 * the shipit MCP bridge's `ask` tool anyway (see `writeMcpConfig`). Revisit
 * with real captures under the planning#435 interactive work.
 *
 * Unknown names — the media/meta tools this table leaves unmapped, and MCP
 * tools — pass through untouched, input and all: renaming keys on a tool we
 * don't know would corrupt its modal display.
 *
 * The guard tests next door tie this table to the real registries (the
 * treatments the docs/272 recognition matrix needs must hold for the mapped
 * names), so a future registry-spelling migration — the planning#337 class —
 * goes red here by name instead of degrading silently.
 */

/** Grok wire tool id → ShipIt transcript tool name. */
export const GROK_TRANSCRIPT_TOOL_NAMES: Record<string, string> = {
  grep: "Grep",
  list_dir: "Glob",
  monitor: "Monitor",
  read_file: "Read",
  run_terminal_command: "Bash",
  scheduler_create: "CronCreate",
  scheduler_delete: "CronDelete",
  scheduler_list: "CronList",
  search_replace: "Edit",
  search_tool: "ToolSearch",
  spawn_subagent: "Agent",
  todo_write: "TodoWrite",
  web_search: "WebSearch",
  workflow: "Workflow",
  write: "Write",
};

/**
 * The advertised names {@link GROK_TRANSCRIPT_TOOL_NAMES} deliberately leaves
 * raw (see the module docstring). Exported so the guard test can hold the two
 * tables disjoint.
 */
export const GROK_UNNORMALIZED_INTERACTIVE_TOOLS = new Set([
  "ask_user_question",
  "enter_plan_mode",
  "exit_plan_mode",
]);

/**
 * Grok's two divergent input-key spellings → the snake_case names the
 * registries read (`SUMMARY_KEYS.file_path`; `path` matches Claude's `Glob`).
 * Applied only to tools in {@link GROK_TRANSCRIPT_TOOL_NAMES}.
 */
const INPUT_KEY_RENAMES: Record<string, string> = {
  target_file: "file_path",
  target_directory: "path",
};

/**
 * Normalize one Grok tool call to the transcript vocabulary. Returns the
 * arguments unchanged (same references) for unknown tool names.
 */
export function normalizeGrokToolCall(
  name: string,
  input: Record<string, unknown>,
): { name: string; input: Record<string, unknown> } {
  const transcriptName = GROK_TRANSCRIPT_TOOL_NAMES[name];
  if (!transcriptName) return { name, input };
  if (!Object.keys(input).some((key) => key in INPUT_KEY_RENAMES)) {
    return { name: transcriptName, input };
  }
  // Rebuilt rather than mutated, preserving key order — the tool-call modal
  // renders `Object.keys(input)` as-is.
  const renamed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    renamed[INPUT_KEY_RENAMES[key] ?? key] = value;
  }
  return { name: transcriptName, input: renamed };
}

/**
 * Grok wraps every tool result in a typed JSON envelope. For most tools that
 * envelope is modal-only and passes through as the honest wire content — but
 * `spawn_subagent` maps to `Agent`, whose result the `SubagentCall` card
 * renders inline as markdown, so the envelope would show as a raw JSON
 * paragraph where the report belongs (the docs/272 RED run's subagent row).
 *
 * Both observed shapes (CLI 1.0.1 captures, 2026-08-18) unwrap to the text a
 * reader wants:
 *
 *   - `{"type":"SubagentCompleted","output":"…", …}` — a foreground spawn; the
 *     `output` IS the subagent's report.
 *   - `{"type":"Text","text":"Subagent started in background.\n…"}` — a
 *     background spawn's launch acknowledgement.
 *
 * The envelope's accounting fields (`subagent_id`, `tool_calls`, `duration_ms`)
 * are dropped knowingly — the full envelope stays on disk and in the result
 * modal via `GET /api/sessions/:id/tool-results/:toolUseId`. A shape this
 * function does not recognize passes through untouched, the safe direction: a
 * future CLI change re-shows an envelope visibly rather than blanking a report.
 *
 * Takes the RAW wire tool id (`spawn_subagent`), matching
 * {@link normalizeGrokToolCall}'s input side; every other tool's output passes
 * through by reference.
 */
export function normalizeGrokToolResult(name: string, output: string): string {
  if (name !== "spawn_subagent") return output;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return output;
  }
  if (typeof parsed !== "object" || parsed === null) return output;
  const envelope = parsed as { type?: unknown; output?: unknown; text?: unknown };
  if (envelope.type === "SubagentCompleted" && typeof envelope.output === "string") {
    return envelope.output;
  }
  if (envelope.type === "Text" && typeof envelope.text === "string") {
    return envelope.text;
  }
  return output;
}
