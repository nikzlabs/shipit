/**
 * Tools that spawn a subagent. Their tool_result carries the subagent's final
 * report, which `SubagentCall` renders in full as markdown with no expand
 * affordance — so it is the one body the docs/244 projection never slices.
 *
 * Lives in shared code because both the client (`visual-elements.ts`, which
 * decides how to draw the call) and the orchestrator projection need the same
 * set, and a drift between them would silently truncate a report.
 */
export const SUBAGENT_TOOL_NAMES = new Set(["Task", "Skill", "Agent"]);
