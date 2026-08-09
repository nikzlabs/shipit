/**
 * The agent's to-do list tools, and the input keys the transcript's task panel
 * draws from them.
 *
 * Claude Code CLI 2.1.220 retired `TodoWrite` and replaced it with a stateful
 * set. The two models are shaped differently, which is why this is a set rather
 * than a rename:
 *
 *   - `TodoWrite` was DECLARATIVE — every call carried the whole list in
 *     `input.todos`, so the transcript could draw the last call and stop.
 *   - `TaskCreate` / `TaskUpdate` are INCREMENTAL — a create adds one task and
 *     an update patches one task by id, so no single call holds the list. It is
 *     folded out of the call sequence instead (`client/components/task-list.ts`).
 *
 * `TodoWrite` stays a member: sessions persisted before the CLI changed still
 * have it in their history, and dropping it would blank their panel on reload.
 *
 * `TaskList` and `TaskGet` are read-only. They change nothing, but they belong
 * here because the panel already shows what they would report — rendering them
 * as ordinary tool lines would just be noise beside it.
 *
 * Deliberately NOT members: `TaskStop` and `TaskOutput`. They share the prefix
 * and nothing else — both act on BACKGROUND tasks (a shell, an agent, a remote
 * session), not on the to-do list, so they stay ordinary tool lines.
 */
export const TASK_LIST_TOOL_NAMES = new Set([
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
]);

/** True when the task panel — not a tool line — is what draws this call. */
export function isTaskListTool(name: string): boolean {
  return TASK_LIST_TOOL_NAMES.has(name);
}

/**
 * The keys of a task-list tool's input that the panel draws.
 *
 * `description` is deliberately absent, and it is the reason this is a key set
 * rather than a whole-input exemption: it is the one long field these tools
 * carry, the panel never shows it, and the docs/244 projection exists to keep
 * exactly that kind of body off the wire.
 *
 * Note what that means, because it differs from every other `drop` in the
 * policy: these calls render as the panel and NOTHING else, so there is no tool
 * line to click and no modal behind them. `description` is therefore dropped
 * with no UI that fetches it back. That is deliberate — no surface displays it
 * either — but it does mean adding a panel field is TWO edits: the renderer and
 * this set. The value is still on disk, so a future detail view can fetch it
 * from `GET /api/sessions/:id/tool-inputs/:toolUseId`.
 *
 * `TodoWrite` never reaches this set: its whole input is kept by
 * `WHOLE_INPUT_TOOL_NAMES`, which `inputKeyTreatment` tests first.
 */
export const TASK_LIST_SUMMARY_KEYS = new Set([
  "taskId",
  "subject",
  "activeForm",
  "status",
]);
