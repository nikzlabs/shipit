import { isPresentTool } from "./tool-names.js";

export const SUBAGENT_TOOL_NAMES = new Set(["Task", "Skill", "Agent"]);
// Skill returns an acknowledgement, not a report.
export const SUBAGENT_REPORT_TOOL_NAMES = new Set(["Task", "Agent"]);

// Answers render in full with no fetch path; slicing would lose visible content.
export const WHOLE_RESULT_TOOL_NAMES = new Set(["AskUserQuestion"]);

export function shipsResultBodyWhole(toolName: string | undefined): boolean {
  return !!toolName && WHOLE_RESULT_TOOL_NAMES.has(toolName);
}

export function rendersResultContentInline(toolName: string | undefined): boolean {
  if (!toolName) return true;
  if (SUBAGENT_REPORT_TOOL_NAMES.has(toolName)) return true;
  if (toolName === "AskUserQuestion") return true;
  if (toolName === "TaskCreate") return true;
  return isPresentTool(toolName);
}
