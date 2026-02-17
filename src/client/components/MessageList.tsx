import { useMemo, useEffect, useRef, useState, useCallback } from "react";
import hljs from "highlight.js";
import "highlight.js/styles/github-dark.css";
import { DiffBlock } from "./DiffBlock.js";
import {
  ThinkingIndicator,
  TypingDots,
  ToolSpinner,
  type StreamingActivity,
} from "./StreamingIndicator.js";
import { AskUserQuestion, type AskQuestionItem } from "./AskUserQuestion.js";
import { ToolResult } from "./ToolResult.js";
import type { SearchMatch } from "../hooks/useSearch.js";

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

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  toolUse?: ToolUseBlock[];
  toolResults?: ToolResultBlock[];
  images?: ChatMessageImage[];
  streaming?: boolean;
  /** When true, this message represents an error (CLI crash, WS drop, etc.) */
  isError?: boolean;
}

function ToolUseItem({ tool, result, isLast, isStreaming, onAnswerQuestion, isQuestionDisabled }: { tool: ToolUseBlock; result?: ToolResultBlock; isLast: boolean; isStreaming: boolean; onAnswerQuestion?: (toolUseId: string, answers: Record<string, string>) => void; isQuestionDisabled: boolean }) {
  // Show a spinner on the last tool when the message is still streaming
  const inProgress = isLast && isStreaming;
  const [collapsed, setCollapsed] = useState(true);
  const hasResult = !!result;

  // Render file-modifying tools as diff blocks
  if (tool.name === "Edit") {
    const filePath = String(tool.input.file_path ?? "unknown");
    const oldString = tool.input.old_string != null ? String(tool.input.old_string) : undefined;
    const newString = tool.input.new_string != null ? String(tool.input.new_string) : undefined;
    return (
      <div>
        <DiffBlock filePath={filePath} oldString={oldString} newString={newString} />
        {inProgress && <ToolProgressBar tool={tool.name} />}
      </div>
    );
  }

  if (tool.name === "Write") {
    const filePath = String(tool.input.file_path ?? "unknown");
    const content = tool.input.content != null ? String(tool.input.content) : "";
    // For Write, show a truncated preview — full files can be very long
    const preview = content.length > 2000 ? content.slice(0, 2000) + "\n... (truncated)" : content;
    return (
      <div>
        <DiffBlock filePath={filePath} newString={preview} isWrite />
        {inProgress && <ToolProgressBar tool={tool.name} />}
      </div>
    );
  }

  if (tool.name === "AskUserQuestion" && Array.isArray(tool.input.questions)) {
    const questions = tool.input.questions as AskQuestionItem[];
    return (
      <AskUserQuestion
        toolUseId={tool.id}
        questions={questions}
        onAnswer={onAnswerQuestion ?? (() => {})}
        disabled={isQuestionDisabled || isStreaming}
      />
    );
  }

  // Fallback: compact one-liner for non-file tools, with optional tool result
  return (
    <div>
      <div className="text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900 rounded px-2 py-1 font-mono flex items-center gap-2">
        {inProgress && <ToolSpinner />}
        <span className={inProgress ? "text-blue-400" : ""}>
          {tool.name}
        </span>
        {"command" in tool.input && tool.input.command ? (
          <span className="ml-1 text-gray-500 truncate max-w-xs">
            {String(tool.input.command).slice(0, 80)}
          </span>
        ) : null}
        {"file_path" in tool.input && tool.input.file_path ? (
          <span className="ml-1 text-gray-500 truncate max-w-xs">
            {String(tool.input.file_path)}
          </span>
        ) : null}
        {"pattern" in tool.input && tool.input.pattern ? (
          <span className="ml-1 text-gray-500 truncate max-w-xs">
            {String(tool.input.pattern)}
          </span>
        ) : null}
        {hasResult && (
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="ml-auto text-gray-500 hover:text-gray-300 transition-colors shrink-0"
            aria-label={collapsed ? "Show output" : "Hide output"}
            aria-expanded={!collapsed}
          >
            {collapsed ? "▶ Show output" : "▼ Hide output"}
          </button>
        )}
      </div>
      {hasResult && !collapsed && (
        <ToolResult tool={tool.name} result={result} />
      )}
    </div>
  );
}

/** Shows a small progress bar under file-modifying tools while they're running. */
function ToolProgressBar({ tool }: { tool: string }) {
  return (
    <div className="flex items-center gap-1.5 mt-1 text-xs text-blue-400">
      <ToolSpinner />
      <span>{tool === "Write" ? "Writing..." : "Applying edit..."}</span>
    </div>
  );
}

// ---- Code block syntax highlighting ----

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

/**
 * Parse message text into alternating text and fenced code block segments.
 * Each segment tracks its character offset in the original text so that
 * search-match positions can be mapped back correctly.
 */
export function parseMessageSegments(text: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        type: "text",
        content: text.slice(lastIndex, match.index),
        offset: lastIndex,
      });
    }
    segments.push({
      type: "code",
      content: match[2],
      language: match[1] || "",
      offset: match.index,
    });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({
      type: "text",
      content: text.slice(lastIndex),
      offset: lastIndex,
    });
  }

  if (segments.length === 0) {
    segments.push({ type: "text", content: text, offset: 0 });
  }

  return segments;
}

/**
 * Filter search matches that fall within a text segment and adjust their
 * start offsets to be relative to that segment's content.
 */
function getSegmentMatches(
  matches: SearchMatch[],
  segOffset: number,
  segLength: number
): SearchMatch[] {
  return matches
    .filter(
      (m) =>
        m.start >= segOffset && m.start + m.length <= segOffset + segLength
    )
    .map((m) => ({ ...m, start: m.start - segOffset }));
}

/** Syntax-highlighted fenced code block. */
function CodeBlock({ code, language }: { code: string; language: string }) {
  const html = useMemo(() => {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language }).value;
    }
    return hljs.highlightAuto(code).value;
  }, [code, language]);

  return (
    <div className="my-2 rounded-md overflow-hidden bg-gray-100 dark:bg-gray-950">
      {language && (
        <div className="text-xs text-gray-500 px-3 py-1 border-b border-gray-300/50 dark:border-gray-700/50">
          {language}
        </div>
      )}
      <pre className="p-3 overflow-x-auto text-xs leading-relaxed">
        <code
          className="hljs"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </pre>
    </div>
  );
}

/**
 * Render message text with search match highlights.
 *
 * Takes the raw text and the list of matches for this specific message,
 * and returns an array of React nodes with <mark> tags around matches.
 * The "current" match (the one actively navigated to) gets an extra CSS
 * class and a ref for scroll-into-view.
 */
function HighlightedText({
  text,
  matches,
  currentMatch,
  currentMatchRef,
}: {
  text: string;
  matches: SearchMatch[];
  currentMatch?: SearchMatch;
  currentMatchRef: React.RefObject<HTMLElement | null>;
}) {
  if (matches.length === 0) return <>{text}</>;

  const parts: React.ReactNode[] = [];
  let cursor = 0;

  for (const match of matches) {
    if (match.start > cursor) {
      parts.push(text.slice(cursor, match.start));
    }
    const isCurrent =
      currentMatch &&
      currentMatch.messageIndex === match.messageIndex &&
      currentMatch.start === match.start;
    parts.push(
      <mark
        key={`${match.start}-${match.length}`}
        ref={isCurrent ? currentMatchRef as React.RefObject<HTMLElement> : undefined}
        className={
          isCurrent
            ? "search-highlight search-highlight--current"
            : "search-highlight"
        }
      >
        {text.slice(match.start, match.start + match.length)}
      </mark>
    );
    cursor = match.start + match.length;
  }

  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }

  return <>{parts}</>;
}

/** Inline editor for a user message being edited. */
function MessageEditor({
  initialText,
  onSave,
  onCancel,
}: {
  initialText: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.focus();
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 200) + "px";
    }
  }, []);

  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 200) + "px";
    }
  }, [text]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const trimmed = text.trim();
      if (trimmed) onSave(trimmed);
    }
    if (e.key === "Escape") {
      onCancel();
    }
  };

  return (
    <div className="w-full max-w-2xl">
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={1}
        className="w-full resize-none rounded-lg bg-blue-700 border border-blue-400 px-4 py-3 text-sm text-white placeholder-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-400"
      />
      <div className="flex justify-end gap-2 mt-1">
        <button
          onClick={onCancel}
          className="text-xs px-3 py-1 rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => {
            const trimmed = text.trim();
            if (trimmed) onSave(trimmed);
          }}
          disabled={!text.trim()}
          className="text-xs px-3 py-1 rounded bg-blue-500 text-white hover:bg-blue-400 disabled:opacity-50 transition-colors"
        >
          Save & Send
        </button>
      </div>
    </div>
  );
}

/** Full-screen lightbox overlay for viewing an image at full size. */
export function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-label="Image preview"
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 text-white/80 hover:text-white text-3xl z-10"
        aria-label="Close preview"
      >
        &times;
      </button>
      <img
        src={src}
        alt={alt}
        className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

/** Render inline image thumbnails for a user message. */
function MessageImages({ images, isUserMessage }: { images: ChatMessageImage[]; isUserMessage: boolean }) {
  const [lightboxImage, setLightboxImage] = useState<{ src: string; alt: string } | null>(null);

  return (
    <>
      {lightboxImage && (
        <ImageLightbox
          src={lightboxImage.src}
          alt={lightboxImage.alt}
          onClose={() => setLightboxImage(null)}
        />
      )}
      <div className={`flex gap-2 flex-wrap ${images.length > 0 && isUserMessage ? "mt-2" : "mb-2"}`} data-testid="message-images">
        {images.map((img, i) => {
          const src = `data:${img.mediaType};base64,${img.data}`;
          const alt = `Attached image ${i + 1}`;
          return (
            <button
              key={i}
              onClick={() => setLightboxImage({ src, alt })}
              className="block rounded-md overflow-hidden border border-white/20 hover:border-white/50 transition-colors cursor-pointer"
              title="Click to view full size"
              aria-label={`View image ${i + 1} full size`}
            >
              <img
                src={src}
                alt={alt}
                className="w-24 h-24 object-cover"
              />
            </button>
          );
        })}
      </div>
    </>
  );
}

export interface CheckpointDivider {
  id: string;
  messageIndex: number;
  label?: string;
}

export function MessageList({
  messages,
  isLoading,
  activity,
  searchMatches,
  currentMatch,
  onEditMessage,
  onAnswerQuestion,
  checkpoints,
}: {
  messages: ChatMessage[];
  isLoading: boolean;
  activity?: StreamingActivity;
  searchMatches?: SearchMatch[];
  currentMatch?: SearchMatch;
  onEditMessage?: (messageIndex: number, newText: string) => void;
  onAnswerQuestion?: (toolUseId: string, answers: Record<string, string>) => void;
  checkpoints?: CheckpointDivider[];
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const currentMatchRef = useRef<HTMLElement | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  const handleEditSave = useCallback(
    (index: number, newText: string) => {
      setEditingIndex(null);
      onEditMessage?.(index, newText);
    },
    [onEditMessage]
  );

  // Cancel editing when loading starts (message was sent)
  useEffect(() => {
    if (isLoading) setEditingIndex(null);
  }, [isLoading]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
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

  // Build a map of messageIndex → checkpoint dividers for rendering
  const checkpointsByIndex = new Map<number, CheckpointDivider[]>();
  if (checkpoints) {
    for (const cp of checkpoints) {
      const arr = checkpointsByIndex.get(cp.messageIndex) ?? [];
      arr.push(cp);
      checkpointsByIndex.set(cp.messageIndex, arr);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-3 sm:py-4 space-y-3 sm:space-y-4">
      {messages.length === 0 && !isLoading && (
        <div className="flex items-center justify-center h-full text-gray-500">
          <p>Send a message to start coding.</p>
        </div>
      )}

      {messages.map((msg, i) => {
        const cpDividers = checkpointsByIndex.get(i);
        const msgMatches = matchesByMessage.get(i) ?? [];
        const segments = parseMessageSegments(msg.text);
        const hasCodeBlocks = segments.some((s) => s.type === "code");
        const isEditing = editingIndex === i;
        const showEditActions = canEdit && msg.role === "user" && !msg.isError && !isEditing;

        return (
          <div key={i}>
            {/* Checkpoint dividers that fall at this message index */}
            {cpDividers && cpDividers.map((cp) => (
              <div
                key={cp.id}
                className="flex items-center gap-3 py-1.5 my-1"
                data-testid="checkpoint-divider"
              >
                <div className="flex-1 h-px bg-amber-500/30" />
                <span className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400 font-medium shrink-0">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 21v-4m0 0V5a2 2 0 012-2h6.5l1 1H21l-3 6 3 6h-8.5l-1-1H5a2 2 0 00-2 2z" />
                  </svg>
                  {cp.label || "Checkpoint"}
                </span>
                <div className="flex-1 h-px bg-amber-500/30" />
              </div>
            ))}
            <div className={`group flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            {/* Edit/Retry buttons — shown on hover for user messages */}
            {showEditActions && (
              <div className="hidden group-hover:flex items-center gap-1 mr-2 shrink-0">
                <button
                  onClick={() => setEditingIndex(i)}
                  className="p-1 rounded text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                  title="Edit message"
                  aria-label="Edit message"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                </button>
                <button
                  onClick={() => onEditMessage?.(i, msg.text)}
                  className="p-1 rounded text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                  title="Retry message"
                  aria-label="Retry message"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </button>
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
                !hasCodeBlocks ? "whitespace-pre-wrap" : ""
              } ${
                msg.isError
                  ? "bg-red-100 dark:bg-red-900/60 text-red-700 dark:text-red-200 border border-red-300 dark:border-red-700/50"
                  : msg.role === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              }`}
            >
              {hasCodeBlocks ? (
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

              {msg.toolUse && msg.toolUse.length > 0 && (
                <div className="mt-2 space-y-1">
                  {msg.toolUse.map((tool, toolIdx) => {
                    // Questions are interactive only on the last assistant message, when not loading/streaming
                    const isLastMessage = i === messages.length - 1;
                    const questionDisabled = !isLastMessage || isLoading || !!msg.streaming;
                    // Match tool result by tool_use_id
                    const toolResult = msg.toolResults?.find((r) => r.toolUseId === tool.id);
                    return (
                      <ToolUseItem
                        key={tool.id}
                        tool={tool}
                        result={toolResult}
                        isLast={toolIdx === msg.toolUse!.length - 1}
                        isStreaming={!!msg.streaming}
                        onAnswerQuestion={onAnswerQuestion}
                        isQuestionDisabled={questionDisabled}
                      />
                    );
                  })}
                </div>
              )}

              {msg.streaming && (
                <span className="inline-flex items-center ml-1 align-middle">
                  <TypingDots />
                </span>
              )}
            </div>
            )}
            </div>
          </div>
        );
      })}

      {/* Thinking indicator — shown when loading and no assistant message has arrived yet */}
      {isLoading && messages[messages.length - 1]?.role === "user" && (
        <ThinkingIndicator activity={activity} />
      )}

      <div ref={bottomRef} />
    </div>
  );
}
