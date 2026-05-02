/**
 * Group a flat list of subagent events by their `parentToolUseId` and
 * separate assistant blocks (text, nested tool calls) from terminal tool
 * results. Used by `SubagentCall` to render a Task tool's prompt, work, and
 * final report inline. (109 — subagent transparency)
 */

import type { SubagentEvent, ToolUseBlock, ToolResultBlock } from "../components/MessageList.js";

/**
 * A single rendered "step" inside a subagent's work timeline. Mirrors
 * `SubagentEvent` but normalized for the renderer:
 * - "assistant" entries carry the subagent's narration and any tool calls.
 * - "tool_result" entries carry results from those tool calls.
 *
 * Order is preserved from the original event stream so the work view shows
 * the subagent's actions chronologically.
 */
export type SubagentStep =
  | { kind: "assistant"; text: string; toolUse: ToolUseBlock[] }
  | { kind: "tool_result"; toolResults: ToolResultBlock[] };

export interface SubagentTree {
  parentToolUseId: string;
  steps: SubagentStep[];
}

/**
 * Group subagent events by their parent tool-use id. Returns a Map keyed by
 * the parent Task tool's id. The renderer looks up entries for a Task tool by
 * its id; absent entries mean "no nested activity yet."
 */
export function groupEventsByParent(events: SubagentEvent[] | undefined): Map<string, SubagentTree> {
  const out = new Map<string, SubagentTree>();
  if (!events) return out;

  for (const ev of events) {
    let tree = out.get(ev.parentToolUseId);
    if (!tree) {
      tree = { parentToolUseId: ev.parentToolUseId, steps: [] };
      out.set(ev.parentToolUseId, tree);
    }
    if (ev.kind === "assistant") {
      tree.steps.push({ kind: "assistant", text: ev.text, toolUse: ev.toolUse });
    } else {
      tree.steps.push({ kind: "tool_result", toolResults: ev.toolResults });
    }
  }
  return out;
}

/**
 * Extract the subagent's "final report" — the markdown text content of the
 * `tool_result` block whose `tool_use_id` is the parent Task call's id. The
 * Task tool's result block is always emitted *outside* the nested events
 * (it's the parent's tool result, not the subagent's). Caller passes the
 * parent message's `toolResults` along with the parent tool id.
 */
export function findSubagentFinalReport(
  parentToolId: string,
  parentToolResults: ToolResultBlock[] | undefined,
): ToolResultBlock | undefined {
  return parentToolResults?.find((r) => r.toolUseId === parentToolId);
}
