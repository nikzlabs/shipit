import type { ChatMessage, ToolUseBlock, ToolResultBlock } from "./MessageList.js";

// Tools that render as standalone items outside the grouped container
export const STANDALONE_TOOLS = new Set(["AskUserQuestion", "TodoWrite", "ExitPlanMode"]);

// Tools extracted into their own top-level visual elements (not grouped, not inside message bubbles)
export const SUBAGENT_TOOLS = new Set(["Task", "Skill", "Agent"]);

export type VisualElement =
  | { kind: "message"; index: number; hideTools: boolean }
  | { kind: "tool-group"; items: { tool: ToolUseBlock; result?: ToolResultBlock; isLast: boolean }[]; streaming: boolean; messageIndices: number[] }
  | { kind: "subagent"; tool: ToolUseBlock; streaming: boolean; messageIndex: number }
  | { kind: "standalone-tool"; tool: ToolUseBlock; result?: ToolResultBlock; streaming: boolean; messageIndex: number };

/**
 * Build a flat list of visual elements from messages.
 * Extracts groupable tools from consecutive assistant messages into shared tool-groups.
 * Text/images/files render as separate message bubbles without tools.
 * Preserves original chronological order — tools from a message appear after that message's text.
 */
export function buildVisualElements(messages: ChatMessage[]): VisualElement[] {
  const elements: VisualElement[] = [];
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
    // Separate subagent tools (Task/Skill) — they get their own top-level elements
    const subagentTools = msg.toolUse?.filter((t) => SUBAGENT_TOOLS.has(t.name)) ?? [];
    const nonSubagentTools = msg.toolUse?.filter((t) => !SUBAGENT_TOOLS.has(t.name)) ?? [];
    const groupableTools = nonSubagentTools.filter((t) => !STANDALONE_TOOLS.has(t.name));
    const canGroupTools = msg.role === "assistant" && groupableTools.length > 0;
    // Inline cards (docs/151 review, docs/163 voice note, docs/164 bug report,
    // session spawn success/failure, fork child) ride on a message whose `text`
    // is empty and which carries no tools — the card field IS the content. Such
    // a message must still emit a `message` element, otherwise the grouping
    // layer silently drops it and the card never renders.
    const hasCardContent =
      msg.agentReview !== undefined
      || msg.voiceNote !== undefined
      || msg.bugReport !== undefined
      || msg.spawnedSession !== undefined
      || msg.spawnFailed !== undefined
      || msg.forkChild !== undefined;

    if (canGroupTools) {
      // Emit a bubble only if the message has visible non-tool content.
      // Flush any accumulated tools first so they appear before this text.
      const hasVisibleContent = !!msg.text.trim() || !!msg.images?.length || !!msg.files?.length;
      if (hasVisibleContent) {
        flushTools();
        elements.push({ kind: "message", index: i, hideTools: true });
      }

      // Extract groupable tools into the accumulator
      for (const tool of groupableTools) {
        const result = msg.toolResults?.find((r) => r.toolUseId === tool.id);
        toolAccum.push({ tool, result });
      }
      toolMsgIndices.push(i);
      lastToolMsgStreaming = !!msg.streaming;

      // Extract standalone tools (ExitPlanMode, AskUserQuestion) as separate elements
      // so they don't force the entire message out of the tool-group rendering path.
      // Without this, force-merging a standalone tool into a message with groupable
      // tools would change the rendering from tool-group → message bubble, causing
      // the tool-group to disappear and the dialog to jump.
      const extractableStandalone = nonSubagentTools.filter(
        (t) => STANDALONE_TOOLS.has(t.name) && t.name !== "TodoWrite",
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
      // When a message has ONLY standalone tools (ExitPlanMode, AskUserQuestion)
      // and no visible text content, extract them as standalone elements instead
      // of rendering an empty bubble. This handles history-loaded messages where
      // ExitPlanMode was persisted in a separate message group from the plan text.
      // Exclude TodoWrite-only messages — those render via lastTodoWriteId in the bubble.
      const extractableStandalone = nonSubagentTools.filter(
        (t) => STANDALONE_TOOLS.has(t.name) && t.name !== "TodoWrite",
      );
      const standaloneOnly = msg.role === "assistant" && !hasVisibleContent
        && extractableStandalone.length > 0
        && nonSubagentTools.every((t) => STANDALONE_TOOLS.has(t.name));
      if (standaloneOnly) {
        for (const tool of extractableStandalone) {
          const result = msg.toolResults?.find((r) => r.toolUseId === tool.id);
          elements.push({ kind: "standalone-tool", tool, result, streaming: !!msg.streaming, messageIndex: i });
        }
      } else {
        // Hide tools in the bubble when the only tools are subagent tools (rendered separately)
        const hideSubagentOnly = subagentTools.length > 0 && nonSubagentTools.length === 0;
        elements.push({ kind: "message", index: i, hideTools: hideSubagentOnly });
      }
    } else {
      // Message has only subagent tools and no other content — no bubble needed
      flushTools();
    }

    // Emit subagent tools as their own top-level elements. Carry the message
    // index so the renderer can dereference the parent's `subagentEvents` and
    // `toolResults` for the nested-tree view (109).
    for (const tool of subagentTools) {
      elements.push({ kind: "subagent", tool, streaming: !!msg.streaming, messageIndex: i });
    }
  }

  flushTools();

  // Post-process: only the last streaming element should show active indicators.
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

  return elements;
}
