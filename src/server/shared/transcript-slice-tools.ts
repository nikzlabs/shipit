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
 * report — rendered in full as markdown by `SubagentCall` with no expand
 * affordance. That makes it the one body the docs/244 projection never slices:
 * a slice would visibly cut the report with no way to get the rest back.
 *
 * One set, two consumers, deliberately: `MessageToolUse` routes exactly these
 * names to `SubagentCall`, and `transcript-projection` exempts exactly these
 * names from slicing. Drift between "renders the report" and "ships the whole
 * report" is what produced both halves of the docs/109 bug — a name that
 * rendered nothing while its unbounded body was shipped anyway (`Skill`), and a
 * name that was shipped whole but rendered nothing (`Agent`).
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
 * Two members, for the same reason arrived at twice:
 *
 *   - `SUBAGENT_REPORT_TOOL_NAMES` — `SubagentCall` renders the final report as
 *     markdown with nothing to click.
 *   - `AskUserQuestion` — the chosen answer is drawn from result content
 *     (`resolvedAnswer={result?.content}`), and the Ask branch of
 *     `MessageToolUse` **returns before the output modal**, so there is no
 *     click, no modal and no fetch. A >16 KB free-form answer used to lose its
 *     tail permanently (SHI-291): recorded as a requirement-4 shortfall, but it
 *     also broke requirement 2 (nothing displays or fetches the rest) and
 *     requirement 8 (the Ask card *is* the transcript). Bounding an answer, if
 *     ever wanted, belongs at the input — not at the projection, which is the
 *     last place that can still see the whole thing.
 *
 * The `present` tool is deliberately absent even though it also reads result
 * content inline: it parses an artifact id out of the head of a compact
 * producer-controlled payload, and a slice keeps the head. `ExitPlanMode` reads
 * result *existence*, so it survives an emptied body.
 */
export const WHOLE_RESULT_TOOL_NAMES = new Set([...SUBAGENT_REPORT_TOOL_NAMES, "AskUserQuestion"]);

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
 *   - `SUBAGENT_REPORT_TOOL_NAMES` — `SubagentCall` renders the final report in
 *     full as markdown (`SubagentCall.tsx:132`), no expand affordance.
 *   - `AskUserQuestion` — the chosen answer comes from result content
 *     (`resolvedAnswer={result?.content}`, `message-tools.tsx:149`).
 *   - the `present` tool — the artifact id is parsed out of the result
 *     (`extractPresentPayload`, `message-tools.tsx:370/380`).
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
  return isPresentTool(toolName);
}
