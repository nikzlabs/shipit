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
