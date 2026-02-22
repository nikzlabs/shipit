import type { ChatMessage, ToolUseBlock, ToolResultBlock } from "./MessageList.js";

// Tools that render as standalone items outside the grouped container
export const STANDALONE_TOOLS = new Set(["AskUserQuestion", "TodoWrite"]);

export type VisualElement =
  | { kind: "message"; index: number; hideTools: boolean }
  | { kind: "tool-group"; items: { tool: ToolUseBlock; result?: ToolResultBlock; isLast: boolean }[]; streaming: boolean; messageIndices: number[] };

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
    const groupableTools = msg.toolUse?.filter((t) => !STANDALONE_TOOLS.has(t.name)) ?? [];
    const hasStandaloneTools = msg.toolUse?.some((t) => STANDALONE_TOOLS.has(t.name)) ?? false;
    const canGroupTools = msg.role === "assistant" && groupableTools.length > 0 && !hasStandaloneTools;

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
    } else {
      flushTools();
      elements.push({ kind: "message", index: i, hideTools: false });
    }
  }

  flushTools();
  return elements;
}
