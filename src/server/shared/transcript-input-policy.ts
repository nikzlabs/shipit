import { SUBAGENT_TOOL_NAMES } from "./transcript-slice-tools.js";
import { isPresentTool } from "./tool-names.js";
import { isTaskListTool, TASK_LIST_SUMMARY_KEYS } from "./task-list-tools.js";

// Below this size, truncation metadata and a later fetch cost more than keeping the value.
export const INPUT_STRIP_FLOOR_BYTES = 200;
export const COMMAND_SUMMARY_CHARS = 80;
export const PLAN_DOC_PATH_MARKER = ".claude/plans/";

export type InputKeyTreatment = "keep" | "head" | "drop";

const SUMMARY_KEYS = new Set(["file_path", "pattern", "query", "url"]);

// apply_patch needs full diffs to compute the inline line counts.
const WHOLE_INPUT_TOOL_NAMES = new Set(["AskUserQuestion", "TodoWrite", "apply_patch"]);
const SUBAGENT_SUMMARY_KEYS = new Set(["description", "subagent_type", "skill", "args"]);

export function isPlanDocumentWrite(toolName: string, input: Record<string, unknown>): boolean {
  return toolName === "Write"
    && typeof input.file_path === "string"
    && input.file_path.includes(PLAN_DOC_PATH_MARKER);
}

// Keep everything rendered without a click; dropped values are fetched on demand.
export function inputKeyTreatment(
  toolName: string,
  key: string,
  input: Record<string, unknown>,
): InputKeyTreatment {
  if (WHOLE_INPUT_TOOL_NAMES.has(toolName)) return "keep";
  if (key === "content" && isPlanDocumentWrite(toolName, input)) return "keep";
  if (SUMMARY_KEYS.has(key)) return "keep";
  if (isTaskListTool(toolName)) return TASK_LIST_SUMMARY_KEYS.has(key) ? "keep" : "drop";
  if (SUBAGENT_TOOL_NAMES.has(toolName)) return SUBAGENT_SUMMARY_KEYS.has(key) ? "keep" : "drop";
  if (isPresentTool(toolName)) return key === "title" ? "keep" : "drop";
  if (key === "command") return "head";
  return "drop";
}
