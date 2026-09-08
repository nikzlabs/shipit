import { isTerminalTranscriptEntry, type VisualElement } from "../visual-elements.js";
import { isTaskListTool } from "../../../server/shared/task-list-tools.js";
import type { ChatMessage } from "./types.js";

export function elementMessageIndex(el: VisualElement): number {
  if (el.kind === "message") return el.index;
  if (el.kind === "tool-group") return el.messageIndices[0] ?? 0;
  return el.messageIndex;
}

export interface CompactRun {
  start: number;
  end: number;
  lastProse: number;
  hasText: boolean;
  /** User message identity survives appends, but not history replacement. */
  identity: ChatMessage;
}

/** Conservative assistant runs. Steered input can split a real turn; keep extra prose then. */
export function compactRuns(messages: ChatMessage[], activeFrom: number): CompactRun[] {
  const runs: CompactRun[] = [];
  let start = -1;
  let lastProse = -1;
  let active = false;
  let hasText = false;
  const flush = (end: number) => {
    if (start >= 0 && !active && end <= activeFrom) {
      runs.push({ start, end, lastProse, hasText, identity: messages[start - 1] ?? messages[start] });
    }
    start = -1;
    lastProse = -1;
    active = false;
    hasText = false;
  };
  messages.forEach((m, index) => {
    if (m.role === "user") {
      flush(index);
      return;
    }
    if (start < 0) start = index;
    hasText ||= !!m.text.trim();
    active ||= !!m.inProgress || !!m.streaming;
    if (m.text.trim() && !m.isError && !m.rolledBack && !isTerminalTranscriptEntry(m)) lastProse = index;
  });
  flush(messages.length);
  return runs;
}

/** Only known ordinary detail can disappear. All special tools/cards/notices stay. */
export function isCompactDetail(el: VisualElement, messages: ChatMessage[], run: CompactRun): boolean {
  if (el.kind === "tool-group") return !el.items.some((item) => item.result?.isError);
  if (el.kind !== "message") return false;
  const m = messages[el.index];
  // Standalone tools with accompanying prose can remain INSIDE the bubble.
  // Keep that whole row, just like an attachment row; hiding it loses the question/plan.
  if (!el.hideTools && m.toolUse?.some((tool) => !isTaskListTool(tool.name))) return false;
  return m.role === "assistant" && el.index !== run.lastProse && !isTerminalTranscriptEntry(m)
    && !m.isError && !m.rolledBack && !m.images?.length && !m.files?.length;
}
