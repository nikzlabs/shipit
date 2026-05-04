// eslint-disable-next-line no-restricted-imports -- useEffect: DOM scroll sync (scrollIntoView), window keydown listener, xterm auto-scroll
import { useMemo, useEffect, useRef, useState } from "react";
import {
  TypingDots,
} from "./StreamingIndicator.js";
import { TodoPanel, type TodoItem } from "./TodoPanel.js";
import { CircleNotchIcon } from "@phosphor-icons/react";
import type { SearchMatch } from "../hooks/useSearch.js";
import { buildVisualElements } from "./visual-elements.js";
import { RollbackDropdown, type RollbackMode } from "./RollbackDropdown.js";
import { RewindDropdown, type RewindMode } from "./RewindDropdown.js";

// Sub-component imports
import { ToolCallGroup, ToolUseItem } from "./message-tools.js";
import { parseMessageSegments, MarkdownContent, MarkdownTooltip, CodeBlock } from "./message-markdown.js";
import { getSegmentMatches, HighlightedText } from "./message-highlighting.js";
import { MessageFileAttachments, MessageImages } from "./message-media.js";
import { SubagentCall } from "./SubagentCall.js";

// ── Type exports (kept here as the canonical location for backward compat) ──

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

/**
 * A single nested event emitted by a subagent (Claude's Task tool). Each entry
 * carries `parentToolUseId` linking it back to a tool_use block in the parent
 * message's `toolUse` list. Used for subagent transparency (109).
 */
export type SubagentEvent =
  | {
      kind: "assistant";
      parentToolUseId: string;
      text: string;
      toolUse: ToolUseBlock[];
    }
  | {
      kind: "tool_result";
      parentToolUseId: string;
      toolResults: ToolResultBlock[];
    };

export interface ChatMessageImage {
  data: string;      // base64-encoded image data
  mediaType: string; // "image/png", etc.
  /** Optional pre-built src URL (e.g. blob: URL for optimistic messages). When set, used directly instead of building a data: URI from data+mediaType. */
  src?: string;
}

export interface ChatMessageFile {
  path: string;
  contentPreview: string;
  startLine?: number;
  endLine?: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  toolUse?: ToolUseBlock[];
  toolResults?: ToolResultBlock[];
  images?: ChatMessageImage[];
  files?: ChatMessageFile[];
  streaming?: boolean;
  /** When true, this message represents an error (CLI crash, WS drop, etc.) */
  isError?: boolean;
  /** When true, this message is queued and waiting for Claude to become available. */
  queued?: boolean;
  /** 1-indexed position in the queue, shown as a badge. */
  queuePosition?: number;
  /** Git commit hash produced by auto-commit after this assistant message. */
  commitHash?: string;
  /** Parent commit hash (HEAD before the auto-commit). Used for rollback. */
  parentCommitHash?: string;
  /** Upload paths consumed by this message (for hydration of pending vs sent state). */
  uploadPaths?: string[];
  /** When true, this message was rolled back and should appear dimmed. */
  rolledBack?: boolean;
  /**
   * Events emitted by subagents (Claude's Task tool) under any tool in this
   * message's `toolUse`. The renderer groups these by `parentToolUseId` and
   * displays them as a nested tree under the parent Task call (109).
   */
  subagentEvents?: SubagentEvent[];
}

export interface TextSegment {
  type: "text";
  content: string;
  offset: number;
}

export interface CodeSegment {
  type: "code";
  content: string;
  language: string;
  offset: number;
}

export type MessageSegment = TextSegment | CodeSegment;

// ── Re-exports from sub-modules (barrel for backward compatibility) ──

export { ToolCallGroup, ToolUseItem, ToolProgressBar } from "./message-tools.js";
export { parseMessageSegments, MarkdownContent, MarkdownTooltip, CodeBlock } from "./message-markdown.js";
export { getSegmentMatches, HighlightedText } from "./message-highlighting.js";
export { MessageEditor } from "./message-editor.js";
export { MessageFileAttachments, MessageImages } from "./message-media.js";

export { buildVisualElements, STANDALONE_TOOLS, SUBAGENT_TOOLS, type VisualElement } from "./visual-elements.js";

export function MessageList({
  messages,
  isLoading,
  searchMatches,
  currentMatch,
  onAnswerQuestion,
  onSendFollowUp,
  onRollback,
  onRewind,
}: {
  messages: ChatMessage[];
  isLoading: boolean;
  searchMatches?: SearchMatch[];
  currentMatch?: SearchMatch;
  onAnswerQuestion?: (toolUseId: string, answers: Record<string, string>) => void;
  onSendFollowUp?: (text: string) => void;
  onRollback?: (messageIndex: number, mode: RollbackMode, parentCommitHash: string) => void;
  onRewind?: (messageIndex: number, mode: RewindMode) => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const currentMatchRef = useRef<HTMLElement | null>(null);
  // Track which message has an open dropdown so the toolbar stays visible
  const [openDropdownIndex, setOpenDropdownIndex] = useState<number | null>(null);

  const lastTodoWriteId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const tools = messages[i].toolUse;
      if (tools) {
        for (let j = tools.length - 1; j >= 0; j--) {
          if (tools[j].name === "TodoWrite") return tools[j].id;
        }
      }
    }
    return null;
  }, [messages]);

  // Find plan content for ExitPlanMode tools by searching backward for a Write
  // tool that wrote to a .claude/plans/ path and extracting the file content.
  const findPlanContent = useMemo(() => {
    return (exitPlanMsgIndex: number): string | undefined => {
      for (let i = exitPlanMsgIndex; i >= 0; i--) {
        const tools = messages[i].toolUse;
        if (!tools) continue;
        for (let j = tools.length - 1; j >= 0; j--) {
          const t = tools[j];
          if (t.name === "Write" && typeof t.input.file_path === "string" && t.input.file_path.includes(".claude/plans/")) {
            return t.input.content as string | undefined;
          }
        }
      }
      return undefined;
    };
  }, [messages]);

  // Track whether the user has scrolled away from the bottom
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      // Consider "at bottom" if within 40px of the end
      autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 40;
    };

    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  // Auto-scroll to bottom only if user hasn't scrolled up.
  // Skip while the user has an active selection inside the message list —
  // otherwise streaming tokens trigger scrollIntoView on every render and
  // continuously cancel the in-progress text selection.
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (!autoScrollRef.current) return;
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (
      sel &&
      !sel.isCollapsed &&
      containerRef.current &&
      sel.anchorNode &&
      containerRef.current.contains(sel.anchorNode)
    ) {
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, [messages, isLoading]);

  // Scroll to the current search match when it changes
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (currentMatch && currentMatchRef.current) {
      currentMatchRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [currentMatch]);

  // Group search matches by message index for efficient lookup
  const matchesByMessage = new Map<number, SearchMatch[]>();
  if (searchMatches) {
    for (const m of searchMatches) {
      const arr = matchesByMessage.get(m.messageIndex) ?? [];
      arr.push(m);
      matchesByMessage.set(m.messageIndex, arr);
    }
  }

  return (
    <div ref={containerRef} className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-6 py-3 sm:py-4 space-y-3 sm:space-y-4">
      {buildVisualElements(messages).map((el, elIdx, allElements) => {
        // ── Tool-group: grouped tool calls from consecutive assistant messages ──
        if (el.kind === "tool-group") {
          return (
            <div key={`tg-${el.messageIndices[0]}`}>
              <ToolCallGroup items={el.items} isStreaming={el.streaming} />
            </div>
          );
        }

        // ── Subagent: standalone Task/Skill/Agent element with left border ──
        if (el.kind === "subagent") {
          const tool = el.tool;
          const parentMsg = messages[el.messageIndex];
          if (tool.name === "Task") {
            // Full transparency view — prompt, work timeline, final report (109)
            return (
              <SubagentCall
                key={tool.id}
                tool={tool}
                subagentEvents={parentMsg?.subagentEvents}
                parentToolResults={parentMsg?.toolResults}
                isStreaming={el.streaming}
              />
            );
          }
          if (tool.name === "Agent") {
            const description = (tool.input.description as string) ?? "Running agent...";
            const subagentType = typeof tool.input.subagent_type === "string" ? tool.input.subagent_type : "";
            const prompt = typeof tool.input.prompt === "string" ? tool.input.prompt : "";
            const label = subagentType ? `Agent (${subagentType}):` : "Agent:";
            return (
              <div key={tool.id} data-testid="subagent-agent" className="border-l-2 border-(--color-success)/40 pl-3 space-y-1">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-semibold text-(--color-success)">{label}</span>
                  <span className="text-(--color-text-primary)">{description}</span>
                </div>
                {prompt && (
                  <MarkdownTooltip content={prompt}>
                    <div className="text-xs text-(--color-text-secondary) font-mono whitespace-pre-wrap overflow-hidden max-h-15 leading-5">{prompt}</div>
                  </MarkdownTooltip>
                )}
              </div>
            );
          }
          // Skill
          const skillName = (tool.input.skill as string) ?? "unknown";
          const args = tool.input.args ? (tool.input.args as string) : "";
          return (
            <div key={tool.id} data-testid="subagent-skill" className="border-l-2 border-(--color-success)/40 pl-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-semibold text-(--color-success)">Skill:</span>
                <span className="text-(--color-text-primary)">{skillName}</span>
                {args && <span className="text-(--color-text-secondary) truncate max-w-xs">{args}</span>}
              </div>
            </div>
          );
        }

        // ── Standalone tool: ExitPlanMode or AskUserQuestion extracted from an empty-text message ──
        if (el.kind === "standalone-tool") {
          // AskUserQuestion / ExitPlanMode block the agent waiting for user
          // input, so the surrounding message keeps `streaming`/`isLoading`
          // true while the prompt is on screen — those flags would dismiss
          // every click. We also can't gate on `isLastMessage`: when Claude
          // continues to emit more content (text or other tool_use blocks)
          // alongside the question, or when the user's answer appends a
          // user-message after the question, the question's message stops
          // being last while the prompt has not yet been answered. That
          // would silently drop the user's click.
          //
          // The right gate is whether the tool itself has been resolved —
          // `el.result` is set once the agent emits a tool_result for it.
          // The AskUserQuestion / PlanApproval components track their own
          // submitted state internally, so leaving `disabled=false` here
          // and feeding them `result` lets them render the answered state
          // correctly even after a page reload (where local state is lost).
          const questionDisabled = !!el.result;
          const resolvedPlanContent = el.tool.name === "ExitPlanMode" ? findPlanContent(el.messageIndex) : undefined;
          return (
            <div key={`st-${el.tool.id}`}>
              <ToolUseItem
                tool={el.tool}
                result={el.result}
                isLast
                isStreaming={el.streaming}
                onAnswerQuestion={onAnswerQuestion}
                onSendFollowUp={onSendFollowUp}
                isQuestionDisabled={questionDisabled}
                planContent={resolvedPlanContent}
              />
            </div>
          );
        }

        // ── Message bubble ──
        const i = el.index;
        const hideTools = el.hideTools;
        const msg = messages[i];
        const msgMatches = matchesByMessage.get(i) ?? [];
        const segments = parseMessageSegments(msg.text);
        const hasCodeBlocks = segments.some((s) => s.type === "code");
        const useMarkdown = msg.role === "assistant" && !msg.isError;
        const showRewind = msg.role === "user" && !msg.isError && !msg.queued && !msg.rolledBack && !!onRewind;
        const latestTodoTool = msg.toolUse?.find((t) => t.name === "TodoWrite" && t.id === lastTodoWriteId);
        // Hide the bubble when it would be empty (no text/images/files
        // and every tool is a TodoWrite, which renders as null inside the bubble)
        const hasVisibleTools = !hideTools && msg.toolUse?.some((t) => t.name !== "TodoWrite");
        const hideBubble = !msg.text && !msg.images?.length && !msg.files?.length && !hasVisibleTools && !!msg.toolUse?.length;

        return (
          <div key={i}>
            {!hideBubble && (
            <div className={`group flex ${msg.role === "user" ? "justify-end" : "justify-start"} ${msg.rolledBack ? "opacity-40" : ""}`}>

            <div
              className={`relative text-sm ${
                !useMarkdown && !hasCodeBlocks ? "whitespace-pre-wrap" : ""
              } ${
                msg.role === "user"
                  ? "max-w-full rounded-lg px-4 py-3"
                  : "w-full"
              } ${
                msg.isError
                  ? "bg-(--color-error-subtle) text-(--color-error) border border-(--color-error)/50"
                  : msg.queued
                  ? "bg-(--color-accent)/40 text-(--color-accent-text)/70 border border-(--color-accent)/30"
                  : msg.role === "user"
                  ? "bg-(--color-accent) text-(--color-accent-text)"
                  : "text-(--color-text-primary)"
              }`}
            >
              {/* Rewind dropdown — shown on hover for user messages */}
              {showRewind && (
                <div className={`${openDropdownIndex === i ? "flex" : "hidden group-hover:flex"} absolute -top-3 -right-3 items-center bg-(--color-bg-secondary) border border-(--color-border-primary) rounded-md shadow-sm px-0.5 py-0.5 z-10`}>
                  <RewindDropdown
                    messageIndex={i}
                    disabled={isLoading}
                    onRewind={onRewind}
                    onOpenChange={(open) => setOpenDropdownIndex(open ? i : null)}
                  />
                </div>
              )}
              {/* Rollback dropdown — shown on hover for assistant messages with a linked commit */}
              {msg.role === "assistant" && msg.commitHash && msg.parentCommitHash && !msg.rolledBack && onRollback && (
                <div className={`${openDropdownIndex === i ? "flex" : "hidden group-hover:flex"} absolute -top-3 -right-3 items-center bg-(--color-bg-secondary) border border-(--color-border-primary) rounded-md shadow-sm px-0.5 py-0.5 z-10`}>
                  <RollbackDropdown
                    messageIndex={i}
                    parentCommitHash={msg.parentCommitHash}
                    disabled={isLoading}
                    onRollback={onRollback}
                    onOpenChange={(open) => setOpenDropdownIndex(open ? i : null)}
                  />
                </div>
              )}
              {msg.queued && (
                <div className="flex items-center gap-1.5 mb-1.5 text-xs text-(--color-accent-text)/80 font-medium">
                  <CircleNotchIcon size={12} className="animate-spin" />
                  Queued{msg.queuePosition !== undefined ? ` #${msg.queuePosition}` : ""}
                </div>
              )}
              {useMarkdown ? (
                <MarkdownContent text={msg.text} />
              ) : hasCodeBlocks ? (
                segments.map((seg, segIdx) => {
                  if (seg.type === "code") {
                    return (
                      <CodeBlock
                        key={segIdx}
                        code={seg.content}
                        language={seg.language}
                      />
                    );
                  }
                  const segMatches = getSegmentMatches(
                    msgMatches,
                    seg.offset,
                    seg.content.length
                  );
                  return (
                    <span key={segIdx} className="whitespace-pre-wrap">
                      <HighlightedText
                        text={seg.content}
                        matches={segMatches}
                        currentMatch={currentMatch}
                        currentMatchRef={currentMatchRef}
                      />
                    </span>
                  );
                })
              ) : (
                <HighlightedText
                  text={msg.text}
                  matches={msgMatches}
                  currentMatch={currentMatch}
                  currentMatchRef={currentMatchRef}
                />
              )}

              {msg.images && msg.images.length > 0 && (
                <MessageImages images={msg.images} isUserMessage={msg.role === "user"} />
              )}

              {msg.files && msg.files.length > 0 && (
                <MessageFileAttachments files={msg.files} />
              )}

              {!hideTools && msg.toolUse && msg.toolUse.length > 0 && (
                <div className="mt-2 space-y-1">
                  {msg.toolUse.map((tool, toolIdx) => {
                    const toolResult = msg.toolResults?.find((r) => r.toolUseId === tool.id);
                    const resolvedPlanContent = tool.name === "ExitPlanMode" ? findPlanContent(i) : undefined;
                    // See note in the standalone-tool branch above — the
                    // right disable signal is whether the tool has a result,
                    // not whether the message is last. AskUserQuestion /
                    // PlanApproval track their submitted state internally
                    // and read `result` to render the answered state on
                    // reload.
                    const questionDisabled = !!toolResult;
                    return (
                      <ToolUseItem
                        key={tool.id}
                        tool={tool}
                        result={toolResult}
                        isLast={toolIdx === msg.toolUse!.length - 1}
                        isStreaming={!!msg.streaming}
                        onAnswerQuestion={onAnswerQuestion}
                        onSendFollowUp={onSendFollowUp}
                        isQuestionDisabled={questionDisabled}
                        planContent={resolvedPlanContent}
                      />
                    );
                  })}
                </div>
              )}

              {msg.streaming && allElements[elIdx + 1]?.kind !== "tool-group" && !latestTodoTool && (
                <span className="inline-flex items-center ml-1 align-middle">
                  <TypingDots />
                </span>
              )}
            </div>
            </div>
            )}
            {latestTodoTool && Array.isArray(latestTodoTool.input.todos) && (
              <div className="flex justify-start mt-1">
                <div className="max-w-2xl">
                  <TodoPanel todos={latestTodoTool.input.todos as TodoItem[]} />
                </div>
              </div>
            )}
          </div>
        );
      })}

      <div ref={bottomRef} />
    </div>
  );
}
