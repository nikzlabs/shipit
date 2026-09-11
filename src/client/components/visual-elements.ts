import type { ChatMessage, ToolUseBlock, ToolResultBlock } from "./MessageList.js";
import { isPresentTool } from "./tool-names.js";
import { TASK_LIST_TOOL_NAMES, isTaskListTool } from "../../server/shared/task-list-tools.js";
import { foldTaskList, type TaskItem } from "./task-list.js";

export const STANDALONE_TOOLS = new Set([
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",

  // they must never be folded into the clipped tool group either.
  ...TASK_LIST_TOOL_NAMES,
]);

// exempts from slicing — those two must not drift, which is why they read the

export { SUBAGENT_TOOL_NAMES as SUBAGENT_TOOLS } from "../../server/shared/transcript-slice-tools.js";
import { SUBAGENT_TOOL_NAMES as SUBAGENT_TOOLS } from "../../server/shared/transcript-slice-tools.js";

/**
 * A tool that must NOT be folded into the clipped `ToolCallGroup` container
 * (`max-h-30 overflow-y-hidden`) — it renders as its own standalone element so
 * it can't be scrolled/hidden behind a stack of Read/Edit/Bash lines.
 *
 * `STANDALONE_TOOLS` is matched by exact name, but the `present` card's tool
 * name is MCP-prefixed and varies (`mcp__shipit__present`, the legacy
 * `mcp__shipit-present__present`, or the bare `present`), so it needs the
 * `isPresentTool` predicate rather than set membership.
 */
function isStandaloneTool(name: string): boolean {
  return STANDALONE_TOOLS.has(name) || isPresentTool(name);
}

/**
 * docs/188 — single source of truth for inline-card message fields that ride on
 * an otherwise-empty (no text, no tools) message, where the card field IS the
 * content. This list is load-bearing on TWO axes, and that's the whole point:
 *
 *   1. RENDER — `buildVisualElements` derives `hasCardContent` from it, so a
 *      field listed here keeps its empty-text carrier message instead of being
 *      dropped before render (the recurring "card renders live but never shows"
 *      / "vanishes" bug — issue-write, compaction, issue-ref all hit this).
 *   2. PERSIST — `chat-history.test.ts` asserts every field here is exercised by
 *      the serialization round-trip contract, which fails unless the field has a
 *      DB column + `toRow`/`fromRow` wiring. So a card added here that ships
 *      emit-only turns CI red.
 *
 * Adding a transcript card? Add its field here. That single edit is what makes
 * it render, and it forces the persistence guard to prove it survives a reload.
 * (Cards that ride on a message carrying its own `text` — e.g. `userReview` on
 * the user's prompt bubble — are NOT listed; they already pass `hasVisibleContent`.)
 */
export const CARD_MESSAGE_FIELDS = [
  "aiReview",
  "voiceNote",
  "bugReport",
  "permissionPrompt",
  "egressPrompt",
  "issueWrite",
  "issueRef",
  "compaction",
  "subAgentConsult",
  "actionChecklist",
  "presentInline",
  "branchAutoReset",
  "branchSynced",
  "sessionRenamed",
  "sessionSettingsChange",
  "releaseCard",
  "spawnedSession",
  "spawnFailed",
  "forkChild",
  "childMerged",
  "selfMergeWatch",
  "sessionReport",
  "nonTurnFailure",
] as const satisfies readonly (keyof ChatMessage)[];

/**
 * A transcript entry that is COMPLETE the moment it is created and is never
 * written to incrementally — so it must never be the merge target for a later
 * streaming-text event (`agent-event.ts`).
 *
 * Two kinds qualify:
 *
 *   - a card carrier (any `CARD_MESSAGE_FIELDS` field), where the card field IS
 *     the content — planning#114;
 *   - a system notice (`notice: true`, docs/138), the muted full-width panel an
 *     `emitNoticeInTurn` call produces (account failover, guarded-mode warning,
 *     pre-turn-reset skip).
 *
 * Both can carry `streaming: true` — a card after a history reload of an
 * in-progress turn, a notice when it is the last row of a running turn's
 * `turn_snapshot` (every `emitNoticeInTurn` fires at turn start, before the
 * agent has produced any assistant content, so a viewer attaching in that gap
 * gets a snapshot whose only row is the notice). The merge rebuilds the target
 * from a fixed field set, so merging into either one silently DROPS its
 * card/notice fields: the panel becomes plain assistant text with the agent's
 * first paragraph concatenated onto it, with no separating space.
 *
 * Adding a new flag of this kind? Add it here — one place, both merge branches.
 */
export function isTerminalTranscriptEntry(msg: ChatMessage): boolean {
  return CARD_MESSAGE_FIELDS.some((f) => msg[f] !== undefined) || msg.notice === true;
}

export type VisualElement =
  | { kind: "message"; index: number; hideTools: boolean }
  | { kind: "tool-group"; items: { tool: ToolUseBlock; result?: ToolResultBlock; isLast: boolean }[]; streaming: boolean; messageIndices: number[] }
  | { kind: "subagent"; tool: ToolUseBlock; streaming: boolean; messageIndex: number }
  | { kind: "standalone-tool"; tool: ToolUseBlock; result?: ToolResultBlock; streaming: boolean; messageIndex: number }
  | { kind: "task-panel"; tasks: TaskItem[]; messageIndex: number };

function sameElement(prev: VisualElement, next: VisualElement): boolean {
  if (prev.kind !== next.kind) return false;
  switch (next.kind) {
    case "message": {
      const p = prev as Extract<VisualElement, { kind: "message" }>;
      return p.index === next.index && p.hideTools === next.hideTools;
    }
    case "tool-group": {
      const p = prev as Extract<VisualElement, { kind: "tool-group" }>;
      return p.streaming === next.streaming
        && p.messageIndices.length === next.messageIndices.length
        && p.messageIndices.every((v, i) => v === next.messageIndices[i])
        && p.items.length === next.items.length
        && p.items.every((it, i) =>
          it.tool === next.items[i].tool
          && it.result === next.items[i].result
          && it.isLast === next.items[i].isLast);
    }
    case "subagent": {
      const p = prev as Extract<VisualElement, { kind: "subagent" }>;
      return p.tool === next.tool && p.streaming === next.streaming && p.messageIndex === next.messageIndex;
    }
    case "standalone-tool": {
      const p = prev as Extract<VisualElement, { kind: "standalone-tool" }>;
      return p.tool === next.tool && p.result === next.result
        && p.streaming === next.streaming && p.messageIndex === next.messageIndex;
    }
    case "task-panel": {
      const p = prev as Extract<VisualElement, { kind: "task-panel" }>;
      return p.messageIndex === next.messageIndex
        && p.tasks.length === next.tasks.length
        && p.tasks.every((t, i) => {
          const o = next.tasks[i];
          return t.id === o.id && t.subject === o.subject
            && t.status === o.status && t.activeForm === o.activeForm;
        });
    }
  }
}

function reuseUnchanged(previous: VisualElement[], next: VisualElement[]): VisualElement[] {
  const out = next;
  const shared = Math.min(previous.length, next.length);
  for (let i = 0; i < shared; i++) {
    if (sameElement(previous[i], next[i])) out[i] = previous[i];
    else break;
  }
  return out;
}

export function buildVisualElements(messages: ChatMessage[], previous?: VisualElement[]): VisualElement[] {
  const elements: VisualElement[] = [];

  const taskList = foldTaskList(messages);
  let toolAccum: { tool: ToolUseBlock; result?: ToolResultBlock }[] = [];
  let toolMsgIndices: number[] = [];
  let lastToolMsgStreaming = false;

  function flushTools() {
    if (toolAccum.length > 0) {
      const items = toolAccum.map((item, idx) => ({
        ...item,
        isLast: idx === toolAccum.length - 1,
      }));
      elements.push({ kind: "tool-group", items, streaming: lastToolMsgStreaming, messageIndices: toolMsgIndices });
      toolAccum = [];
      toolMsgIndices = [];
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    const subagentTools = msg.toolUse?.filter((t) => SUBAGENT_TOOLS.has(t.name)) ?? [];
    const nonSubagentTools = msg.toolUse?.filter((t) => !SUBAGENT_TOOLS.has(t.name)) ?? [];
    const groupableTools = nonSubagentTools.filter((t) => !isStandaloneTool(t.name));
    const canGroupTools = msg.role === "assistant" && groupableTools.length > 0;

    // tools — the card field IS the content. Such a message must still emit a

    // card never renders (the recurring "card vanishes" bug, docs/188). Driven

    const hasCardContent = CARD_MESSAGE_FIELDS.some((f) => msg[f] !== undefined);

    if (canGroupTools) {

      const hasVisibleContent = !!msg.text.trim() || !!msg.images?.length || !!msg.files?.length;
      if (hasVisibleContent) {
        flushTools();
        elements.push({ kind: "message", index: i, hideTools: true });
      }

      for (const tool of groupableTools) {
        const result = msg.toolResults?.find((r) => r.toolUseId === tool.id);
        toolAccum.push({ tool, result });
      }
      toolMsgIndices.push(i);
      lastToolMsgStreaming = !!msg.streaming;

      const extractableStandalone = nonSubagentTools.filter(
        (t) => isStandaloneTool(t.name) && !isTaskListTool(t.name),
      );
      if (extractableStandalone.length > 0) {
        flushTools();
        for (const tool of extractableStandalone) {
          const result = msg.toolResults?.find((r) => r.toolUseId === tool.id);
          elements.push({ kind: "standalone-tool", tool, result, streaming: !!msg.streaming, messageIndex: i });
        }
      }
    } else if (nonSubagentTools.length > 0 || msg.text.trim() || msg.images?.length || msg.files?.length || msg.role === "user" || hasCardContent) {
      flushTools();
      const hasVisibleContent = !!msg.text.trim() || !!msg.images?.length || !!msg.files?.length;

      const extractableStandalone = nonSubagentTools.filter(
        (t) => isStandaloneTool(t.name) && !isTaskListTool(t.name),
      );
      const standaloneOnly = msg.role === "assistant" && !hasVisibleContent
        && extractableStandalone.length > 0
        && nonSubagentTools.every((t) => isStandaloneTool(t.name));
      if (standaloneOnly) {
        for (const tool of extractableStandalone) {
          const result = msg.toolResults?.find((r) => r.toolUseId === tool.id);
          elements.push({ kind: "standalone-tool", tool, result, streaming: !!msg.streaming, messageIndex: i });
        }
      } else {

        const hideSubagentOnly = subagentTools.length > 0
          && nonSubagentTools.every((t) => isTaskListTool(t.name));
        elements.push({ kind: "message", index: i, hideTools: hideSubagentOnly });
      }
    } else {

      flushTools();
    }

    for (const tool of subagentTools) {
      elements.push({ kind: "subagent", tool, streaming: !!msg.streaming, messageIndex: i });
    }

    if (i === taskList?.anchorIndex && taskList.tasks.length > 0) {
      flushTools();
      elements.push({ kind: "task-panel", tasks: taskList.tasks, messageIndex: i });
    }
  }

  flushTools();

  // Earlier tool-groups/subagents must not display spinners.
  let foundStreaming = false;
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if ((el.kind === "tool-group" || el.kind === "subagent") && el.streaming) {
      if (foundStreaming) {
        el.streaming = false;
      } else {
        foundStreaming = true;
      }
    }
  }

  return previous ? reuseUnchanged(previous, elements) : elements;
}
