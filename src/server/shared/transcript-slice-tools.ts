import { isPresentTool } from "./tool-names.js";

/**
 * Tools that spawn a subagent, and thus render as their own top-level element
 * in the transcript instead of being folded into the clipped tool-call group.
 *
 * Membership here is about LAYOUT only — see `SUBAGENT_REPORT_TOOL_NAMES` for
 * the (narrower) set whose result body is rendered in full.
 */
export const SUBAGENT_TOOL_NAMES = new Set(["Task", "Skill", "Agent"]);

/**
 * The subset of `SUBAGENT_TOOL_NAMES` whose tool_result IS the subagent's final
 * report — the body `SubagentCall` renders as markdown.
 *
 * One set, two consumers, deliberately: `MessageToolUse` routes exactly these
 * names to `SubagentCall`, and `transcript-projection` sends exactly these
 * names through the report-shaped slice ({@link sliceSubagentReport}) rather
 * than the generic one. Drift between "renders the report" and "is projected as
 * a report" is what produced both halves of the docs/109 bug — a name that
 * rendered nothing while its unbounded body was shipped anyway (`Skill`), and a
 * name that was shipped whole but rendered nothing (`Agent`).
 *
 * These used to be exempt from slicing altogether, on the grounds that the
 * report rendered in full with nothing to click. It now clamps inline behind a
 * modal, so the exemption is gone — see `WHOLE_RESULT_TOOL_NAMES`.
 *
 * `Skill` is deliberately absent. Verified against Claude Code CLI 2.1.219: an
 * in-context skill invocation emits a ~33-character tool_result (a base-directory
 * acknowledgement) and no nested `parent_tool_use_id` events at all — the skill's
 * actual content arrives as a separate top-level user message. There is no report
 * to render, so `SubagentCall` would draw an empty shell, and exempting the body
 * from every size bound bought nothing.
 */
export const SUBAGENT_REPORT_TOOL_NAMES = new Set(["Task", "Agent"]);

/**
 * Tools whose result body must ship **whole** — never sliced, never capped.
 *
 * The invariant, and the reason this is a set rather than an `||` at two call
 * sites: the transcript renders this result's content *in full* and offers **no
 * expand affordance and no fetch path**. Cutting it therefore destroys text
 * with no way to get it back. That is strictly worse than shipping bytes, so
 * every bound in the feature — the server's 16 KB backstop and the client's
 * 1 MB cap — has to agree on this set.
 *
 * One member:
 *
 *   - `AskUserQuestion` — the chosen answer is drawn from result content
 *     (`resolvedAnswer={result?.content}`), and the Ask branch of
 *     `MessageToolUse` **returns before the output modal**, so there is no
 *     click, no modal and no fetch. A >16 KB free-form answer used to lose its
 *     tail permanently (planning#293): recorded as a requirement-4 shortfall, but it
 *     also broke requirement 2 (nothing displays or fetches the rest) and
 *     requirement 8 (the Ask card *is* the transcript). Bounding an answer, if
 *     ever wanted, belongs at the input — not at the projection, which is the
 *     last place that can still see the whole thing.
 *
 * **`SUBAGENT_REPORT_TOOL_NAMES` was the other member and is no longer one**
 * (docs/109 requirement 8). The membership test is "renders in full with
 * nothing to click", and the report now clamps inline with a *Show the full
 * report* modal behind it, so the premise is gone: it is sliced by
 * {@link sliceSubagentReport} and the modal fetches the rest from
 * `/api/sessions/:id/tool-results/:toolUseId`. Slicing it is only safe *because*
 * that click exists — if the modal is ever removed, this set is where the report
 * has to come back.
 *
 * The `present` tool is deliberately absent even though it also reads result
 * content inline: it parses an artifact id out of the head of a compact
 * producer-controlled payload, and a slice keeps the head. `ExitPlanMode` reads
 * result *existence*, so it survives an emptied body.
 */
export const WHOLE_RESULT_TOOL_NAMES = new Set(["AskUserQuestion"]);

/** True when `toolName`'s result body must never be sliced or capped. */
export function shipsResultBodyWhole(toolName: string | undefined): boolean {
  return !!toolName && WHOLE_RESULT_TOOL_NAMES.has(toolName);
}

/**
 * Tools whose result *content* is read by something the transcript draws
 * without a click. For every other tool the content is modal-only, so the
 * transcript may carry none of it at all.
 *
 * This is the predicate requirement 1 actually turns on. The original design
 * shipped the first 40 lines of every result, a number derived from the inline
 * previews in `ToolResult.tsx` — but `ToolResult` renders *only* inside
 * `ToolCallModal` (`message-tools.tsx`), which is a click. The transcript line
 * is built from the tool's **input**. So those 40 lines were 40 lines of
 * something nobody sees, which is precisely what requirement 1 forbids.
 *
 * The three inline readers, each verified at its call site:
 *
 *   - `SUBAGENT_REPORT_TOOL_NAMES` — `SubagentCall` renders the report inline,
 *     clamped, with the rest behind the *Show the full report* modal. Still a
 *     `true`: the clamped part IS drawn without a click, so the head has to
 *     ship. Only the tail moved behind the fetch.
 *   - `AskUserQuestion` — the chosen answer comes from result content
 *     (`resolvedAnswer={result?.content}`, `message-tools.tsx:149`).
 *   - the `present` tool — the artifact id is parsed out of the result
 *     (`extractPresentPayload`, `message-tools.tsx:370/380`).
 *   - `TaskCreate` — the CLI assigns the task's id and returns it in the
 *     RESULT (`Task #1 created successfully: …`), never in the input. The task
 *     panel's fold parses it (`createdTaskId`, `client/components/task-list.ts`)
 *     and `TaskUpdate.taskId` refers to it, so a result emptied here strands
 *     the task on its provisional key and every later update misses it. Like
 *     `present`, it needs only the HEAD of a compact producer-controlled
 *     string, so the ordinary slice is enough — this does not belong in
 *     `WHOLE_RESULT_TOOL_NAMES`.
 *
 * `ExitPlanMode` is deliberately absent: it reads `resolved={!!result}`, result
 * *existence* only, which survives an emptied body.
 *
 * An unknown or unresolvable tool name is treated as inline-rendering. Being
 * wrong in that direction ships bytes; being wrong in the other direction
 * blanks a card that has no fetch path to recover it.
 */
export function rendersResultContentInline(toolName: string | undefined): boolean {
  if (!toolName) return true;
  if (SUBAGENT_REPORT_TOOL_NAMES.has(toolName)) return true;
  if (toolName === "AskUserQuestion") return true;
  if (toolName === "TaskCreate") return true;
  return isPresentTool(toolName);
}
