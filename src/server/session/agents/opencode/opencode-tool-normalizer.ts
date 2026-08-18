/**
 * Pure tool-call normalization for the OpenCode adapter (planning#432).
 *
 * OpenCode's wire speaks lowercase tool ids (`todowrite`, `edit`, `write`,
 * `task`) with camelCase input keys (`filePath`, `oldString`, `newString`).
 * ShipIt's recognition registries — the task panel, `DIFF_INPUT_TOOLS`, the
 * subagent card, `inputKeyTreatment`'s keep-lists — key on the transcript
 * vocabulary, which is Claude-spelled. An unrecognized name mostly degrades to
 * a generic row, but two registries *destroy data* on a miss: `inputKeyTreatment`
 * defaults to `drop` (a `todowrite` had its `todos` stripped off the wire with
 * no fetch path back), and `rendersResultContentInline` returns false (a
 * subagent's report body is emptied).
 *
 * So the adapter translates at the Layer A boundary, exactly like the Codex
 * adapter does (`codex-tool-normalizer.ts` — "the normalized tool-call inputs,
 * diffs, and summaries ShipIt's chat model expects"; it synthesizes `Agent`,
 * `WebFetch`, `apply_patch` from a wire that has no tool names at all). The
 * persisted tool name is ShipIt's transcript vocabulary, not a raw wire echo.
 *
 * The mapping is semantic, not cosmetic — each target was chosen against the
 * registry that renders it:
 *
 *   - `todowrite` → `TodoWrite`: OpenCode's to-do tool is DECLARATIVE (whole
 *     list in `todos`, items `{content, status}`) — the fold's `TodoWrite`
 *     branch, not the incremental `TaskCreate` model.
 *   - `task` → `Agent`: carries `description`/`prompt`/`subagent_type`,
 *     already the subagent key set. `Agent` rather than `Task` because `Agent`
 *     is in the Claude tool map, which lets the guard test hold every mapping
 *     to canonical coherence: canonicalizeTool("opencode", raw) must equal
 *     canonicalizeTool("claude", transcript).
 *   - `edit`/`write`/`read`: the name plus the camelCase→snake_case key
 *     renames make `diffStatsFor` (`DIFF_BODY_KEYS`) and the `file_path`
 *     summary work unchanged.
 *
 * Unknown names — MCP tools included — pass through untouched, input and all:
 * renaming keys on a tool we don't know would corrupt its modal display.
 *
 * The guard tests next door tie this table to `OPENCODE_TOOL_NAMES` (every
 * advertised name must map) and to the real registries (the treatments the
 * planning#432 surfaces need must hold for the mapped names), so a future
 * registry-spelling migration — the planning#337 class — goes red here by
 * name instead of degrading silently.
 */

/** OpenCode wire tool id → ShipIt transcript tool name. */
export const OPENCODE_TRANSCRIPT_TOOL_NAMES: Record<string, string> = {
  bash: "Bash",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  read: "Read",
  skill: "Skill",
  task: "Agent",
  todowrite: "TodoWrite",
  webfetch: "WebFetch",
  write: "Write",
};

/**
 * camelCase wire keys → the snake_case spellings the registries read
 * (`SUMMARY_KEYS.file_path`, `DIFF_BODY_KEYS`). Applied only to tools in
 * {@link OPENCODE_TRANSCRIPT_TOOL_NAMES}.
 */
const INPUT_KEY_RENAMES: Record<string, string> = {
  filePath: "file_path",
  oldString: "old_string",
  newString: "new_string",
};

/**
 * OpenCode's `task` result wraps the subagent's report in XML-ish tags,
 * straight from the CLI (verified 1.18.15, docs/272-harness-conversion-verification
 * runs 2026-08-18):
 *
 *     <task id="ses_…" state="completed">
 *     <task_result>
 *     …the report…
 *     </task_result>
 *     </task>
 *
 * The client renders the report as markdown with `skipHtml`, and in CommonMark
 * the `<task …>` line opens an HTML block that runs to the next blank line —
 * so the whole wrapper, report included, was dropped and the panel rendered
 * empty (planning#434). Anchored full-match: a shape this regex does not
 * recognize passes through untouched, the safe direction — a future CLI change
 * re-shows a wrapper visibly rather than corrupting a report. Greedy inner, so
 * a report that itself contains `</task_result>` keeps it (the match takes the
 * LAST closing pair).
 */
const TASK_RESULT_WRAPPER =
  /^\s*<task\b[^>]*>\s*<task_result>([\s\S]*)<\/task_result>\s*<\/task>\s*$/;

/**
 * Normalize one OpenCode tool result at the same Layer A boundary the name
 * normalization lives at, so the persisted content IS the subagent's report.
 * The wrapper's `id`/`state` attributes are dropped knowingly: the call id is
 * already the result block's `tool_use_id`, and error state is `is_error`.
 * Takes the RAW wire tool id (`task`), matching {@link normalizeOpencodeToolCall}'s
 * input side; every other tool's output passes through by reference.
 */
export function normalizeOpencodeToolResult(name: string, output: string): string {
  if (name !== "task") return output;
  const match = TASK_RESULT_WRAPPER.exec(output);
  if (!match) return output;
  // Strip exactly the one newline the wrapper adds on each side — a report
  // that opens with indentation (a markdown code block) keeps it.
  return match[1].replace(/^\n/, "").replace(/\n$/, "");
}

/**
 * Normalize one OpenCode tool call to the transcript vocabulary. Returns the
 * arguments unchanged (same references) for unknown tool names.
 */
export function normalizeOpencodeToolCall(
  name: string,
  input: Record<string, unknown>,
): { name: string; input: Record<string, unknown> } {
  const transcriptName = OPENCODE_TRANSCRIPT_TOOL_NAMES[name];
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
