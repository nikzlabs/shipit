// Barrel for the MessageList directory. Preserves every name the old monolithic
// `MessageList.tsx` exported, so the historical `./components/MessageList` import
// path resolves unchanged (via the sibling shim file).

// ── Type exports (canonical location for backward compat) ──
export type {
  ToolUseBlock,
  ToolResultBlock,
  SubagentEvent,
  ChatMessageImage,
  ChatMessageFile,
  ChatMessage,
  TextSegment,
  CodeSegment,
  MessageSegment,
} from "./types.js";

// ── Re-exports from sub-modules (barrel for backward compatibility) ──
export { ToolCallGroup, ToolUseItem, ToolProgressBar } from "../message-tools.js";
export { parseMessageSegments, MarkdownContent, MarkdownTooltip, CodeBlock } from "../message-markdown.js";
export { getSegmentMatches, HighlightedText } from "../message-highlighting.js";
export { MessageEditor } from "../message-editor.js";
export { MessageFileAttachments, MessageImages } from "../message-media.js";
export { buildVisualElements, STANDALONE_TOOLS, SUBAGENT_TOOLS, type VisualElement } from "../visual-elements.js";

export { MessageList } from "./MessageList.js";
