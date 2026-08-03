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
