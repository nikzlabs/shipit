// eslint-disable-next-line no-restricted-imports -- useEffect: DOM scroll sync (scrollIntoView), window keydown listener, xterm auto-scroll
import { useMemo, useEffect, useRef, useState, useCallback } from "react";
import {
  ThinkingIndicator,
  TypingDots,
  type StreamingActivity,
} from "./StreamingIndicator.js";
import { TodoPanel, type TodoItem } from "./TodoPanel.js";
import { Button } from "./ui/button.js";
import { CircleNotchIcon, PencilSimpleIcon, ArrowsClockwiseIcon } from "@phosphor-icons/react";
import type { SearchMatch } from "../hooks/useSearch.js";
import { buildVisualElements } from "./visual-elements.js";
import { RollbackDropdown, type RollbackMode } from "./RollbackDropdown.js";

// Sub-component imports
import { ToolCallGroup, ToolUseItem } from "./message-tools.js";
import { parseMessageSegments, MarkdownContent, MarkdownTooltip, CodeBlock } from "./message-markdown.js";
import { getSegmentMatches, HighlightedText } from "./message-highlighting.js";
import { MessageEditor } from "./message-editor.js";
import { MessageFileAttachments, MessageImages } from "./message-media.js";

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

export interface ChatMessageImage {
  data: string;      // base64-encoded image data
  mediaType: string; // "image/png", etc.
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
  /** When true, this message was rolled back and should appear dimmed. */
  rolledBack?: boolean;
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
export { ImageLightbox, MessageFileAttachments, MessageImages } from "./message-media.js";

export { buildVisualElements, STANDALONE_TOOLS, SUBAGENT_TOOLS, type VisualElement } from "./visual-elements.js";

export function MessageList({
  messages,
  isLoading,
  activity,
  searchMatches,
  currentMatch,
  onEditMessage,
  onAnswerQuestion,
  onSendFollowUp,
  onRollback,
}: {
  messages: ChatMessage[];
  isLoading: boolean;
  activity?: StreamingActivity;
  searchMatches?: SearchMatch[];
  currentMatch?: SearchMatch;
  onEditMessage?: (messageIndex: number, newText: string) => void;
  onAnswerQuestion?: (toolUseId: string, answers: Record<string, string>) => void;
  onSendFollowUp?: (text: string) => void;
  onRollback?: (messageIndex: number, mode: RollbackMode, parentCommitHash: string) => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const currentMatchRef = useRef<HTMLElement | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

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

  const handleEditSave = useCallback(
    (index: number, newText: string) => {
      setEditingIndex(null);
      onEditMessage?.(index, newText);
    },
    [onEditMessage]
  );

  // Cancel editing when loading starts (inline state reset during render)
  const prevIsLoadingRef = useRef(isLoading);
  if (isLoading && !prevIsLoadingRef.current) {
    setEditingIndex(null);
  }
  prevIsLoadingRef.current = isLoading;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, [messages, isLoading]);

  // Scroll to the current search match when it changes
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

  // Whether edit/retry actions are available (not loading, handler provided)
  const canEdit = !isLoading && !!onEditMessage;

  return (
    <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-3 sm:py-4 space-y-3 sm:space-y-4">
      {messages.length === 0 && !isLoading && (
        <div className="flex items-center justify-center h-full text-(--color-text-secondary)">
          <p>Send a message to start coding.</p>
        </div>
      )}

      {buildVisualElements(messages).map((el, elIdx, allElements) => {
        // ── Tool-group: grouped tool calls from consecutive assistant messages ──
        if (el.kind === "tool-group") {
          return (
            <div key={`tg-${el.messageIndices[0]}`}>
              <ToolCallGroup items={el.items} isStreaming={el.streaming} />
            </div>
          );
        }

        // ── Subagent: standalone Task/Skill element with left border ──
        if (el.kind === "subagent") {
          const tool = el.tool;
          if (tool.name === "Task") {
            const description = (tool.input.description as string) ?? "Running task...";
            const prompt = typeof tool.input.prompt === "string" ? tool.input.prompt : "";
            return (
              <div key={tool.id} data-testid="subagent-task" className="border-l-2 border-(--color-success)/40 pl-3 space-y-1">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-semibold text-(--color-success)">Subagent:</span>
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

        // ── Message bubble ──
        const i = el.index;
        const hideTools = el.hideTools;
        const msg = messages[i];
        const msgMatches = matchesByMessage.get(i) ?? [];
        const segments = parseMessageSegments(msg.text);
        const hasCodeBlocks = segments.some((s) => s.type === "code");
        const useMarkdown = msg.role === "assistant" && !msg.isError;
        const isEditing = editingIndex === i;
        const showEditActions = canEdit && msg.role === "user" && !msg.isError && !isEditing && !msg.queued;
        const latestTodoTool = msg.toolUse?.find((t) => t.name === "TodoWrite" && t.id === lastTodoWriteId);
        // Hide the bubble when it would be empty (no text/images/files
        // and every tool is a TodoWrite, which renders as null inside the bubble)
        const hasVisibleTools = !hideTools && msg.toolUse?.some((t) => t.name !== "TodoWrite");
        const hideBubble = !msg.text && !msg.images?.length && !msg.files?.length && !hasVisibleTools && !!msg.toolUse?.length;

        return (
          <div key={i}>
            {!hideBubble && (
            <div className={`group flex ${msg.role === "user" ? "justify-end" : "justify-start"} ${msg.rolledBack ? "opacity-40" : ""}`}>
            {/* Edit/Retry buttons — shown on hover for user messages */}
            {showEditActions && (
              <div className="hidden group-hover:flex items-center gap-1 mr-2 shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditingIndex(i)}
                  className="p-1"
                  title="Edit message"
                  aria-label="Edit message"
                >
                  <PencilSimpleIcon size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onEditMessage?.(i, msg.text)}
                  className="p-1"
                  title="Retry message"
                  aria-label="Retry message"
                >
                  <ArrowsClockwiseIcon size={14} />
                </Button>
              </div>
            )}

            {isEditing ? (
              <MessageEditor
                initialText={msg.text}
                onSave={(newText) => handleEditSave(i, newText)}
                onCancel={() => setEditingIndex(null)}
              />
            ) : (
            <div
              className={`max-w-2xl rounded-lg px-4 py-3 text-sm ${
                !useMarkdown && !hasCodeBlocks ? "whitespace-pre-wrap" : ""
              } ${
                msg.isError
                  ? "bg-(--color-error-subtle) text-(--color-error) border border-(--color-error)/50"
                  : msg.queued
                  ? "bg-(--color-accent)/40 text-(--color-accent-text)/70 border border-(--color-accent)/30"
                  : msg.role === "user"
                  ? "bg-(--color-accent) text-(--color-accent-text)"
                  : "bg-(--color-bg-secondary) text-(--color-text-primary)"
              }`}
            >
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

              {!hideTools && msg.toolUse && msg.toolUse.length > 0 && (() => {
                const isLastMessage = i === messages.length - 1;
                const questionDisabled = !isLastMessage || isLoading || !!msg.streaming;
                return (
                  <div className="mt-2 space-y-1">
                    {msg.toolUse.map((tool, toolIdx) => {
                      const toolResult = msg.toolResults?.find((r) => r.toolUseId === tool.id);
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
                        />
                      );
                    })}
                  </div>
                );
              })()}

              {msg.streaming && allElements[elIdx + 1]?.kind !== "tool-group" && (
                <span className="inline-flex items-center ml-1 align-middle">
                  <TypingDots />
                </span>
              )}
            </div>
            )}
            {/* Rollback button — shown on hover for assistant messages with a linked commit */}
            {msg.role === "assistant" && msg.commitHash && msg.parentCommitHash && !msg.rolledBack && onRollback && (
              <div className="hidden group-hover:flex items-center ml-2 shrink-0">
                <RollbackDropdown
                  messageIndex={i}
                  parentCommitHash={msg.parentCommitHash}
                  disabled={isLoading}
                  onRollback={onRollback}
                />
              </div>
            )}
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

      {/* Thinking indicator — shown when waiting for the first response,
         or when a tool is actively executing (to surface the activity label). */}
      {isLoading && (messages[messages.length - 1]?.role === "user" || activity?.tool) && (
        <ThinkingIndicator activity={activity} />
      )}

      <div ref={bottomRef} />
    </div>
  );
}
