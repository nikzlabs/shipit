

import type { SubagentEvent, ToolUseBlock, ToolResultBlock } from "../components/MessageList.js";

export type SubagentStep =
  | { kind: "assistant"; text: string; toolUse: ToolUseBlock[] }
  | { kind: "tool_result"; toolResults: ToolResultBlock[] };

export interface SubagentTree {
  parentToolUseId: string;
  steps: SubagentStep[];
}

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

export function findSubagentFinalReport(
  parentToolId: string,
  parentToolResults: ToolResultBlock[] | undefined,
): ToolResultBlock | undefined {
  return parentToolResults?.find((r) => r.toolUseId === parentToolId);
}

/**
 * Report parsing moved to `server/shared/subagent-report.ts` when the report
 * stopped shipping whole (docs/109 requirement 8): the projection has to
 * produce a clamped payload the client parser still understands, so the two
 * halves must be the same code. Re-exported here so every existing import path
 * keeps working — same pattern as `visual-elements.ts` re-exporting
 * `SUBAGENT_TOOL_NAMES`.
 */
export {
  parseSubagentReport,
  parseReportMeta,
  isBackgroundLaunchAck,
  type ParsedSubagentReport,
  type SubagentReportMeta,
} from "../../server/shared/subagent-report.js";
