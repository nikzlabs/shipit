import { useMemo, useEffect, useRef, useState, useCallback } from "react";
import hljs from "highlight.js";
import "highlight.js/styles/github.css";
import { Marked } from "marked";
import { DiffBlock } from "./DiffBlock.js";
import {
  ThinkingIndicator,
  TypingDots,
  ToolSpinner,
  type StreamingActivity,
} from "./StreamingIndicator.js";
import { AskUserQuestion, type AskQuestionItem } from "./AskUserQuestion.js";
import { ToolResult } from "./ToolResult.js";
import { TodoPanel, type TodoItem } from "./TodoPanel.js";
import { sessionRelativePath } from "../path-utils.js";
import { CircleNotchIcon } from "@phosphor-icons/react";
import type { SearchMatch } from "../hooks/useSearch.js";
import { buildVisualElements } from "./visual-elements.js";
import { RollbackDropdown, type RollbackMode } from "./RollbackDropdown.js";

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

/** Scrollable container for consecutive tool calls. Max 5 lines, auto-scrolls during streaming. */
function ToolCallGroup({ items, isStreaming }: {
  items: { tool: ToolUseBlock; result?: ToolResultBlock; isLast: boolean }[];
  isStreaming: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new tools are added during streaming
  useEffect(() => {
    if (isStreaming && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [items.length, isStreaming]);

  return (
    <div
      ref={scrollRef}
      className="bg-(--color-bg-secondary) rounded max-h-30 overflow-y-auto"
      data-testid="tool-call-group"
    >
      {items.map(({ tool, result, isLast }) => (
        <ToolUseItem
          key={tool.id}
          tool={tool}
          result={result}
          isLast={isLast}
          isStreaming={isStreaming}
          isQuestionDisabled
          grouped
        />
      ))}
    </div>
  );
}

export { buildVisualElements, STANDALONE_TOOLS, SUBAGENT_TOOLS, type VisualElement } from "./visual-elements.js";

function ToolUseItem({ tool, result, isLast, isStreaming, onAnswerQuestion, isQuestionDisabled, grouped }: { tool: ToolUseBlock; result?: ToolResultBlock; isLast: boolean; isStreaming: boolean; onAnswerQuestion?: (toolUseId: string, answers: Record<string, string>) => void; isQuestionDisabled: boolean; grouped?: boolean }) {
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
    return (
      <div>
        <DiffBlock filePath={filePath} newString={content} isWrite />
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

  if (tool.name === "TodoWrite") {
    return null; // latest is rendered outside the bubble; older ones are hidden
  }

  // Fallback: compact one-liner for non-file tools, with optional tool result
  return (
    <div>
      <div className={`text-xs text-(--color-text-secondary) px-2 py-1 font-mono flex items-center gap-2${grouped ? "" : " bg-(--color-bg-secondary) rounded"}`}>
        {inProgress && <ToolSpinner />}
        <span className={inProgress ? "text-(--color-accent)" : ""}>
          {tool.name}
        </span>
        {"command" in tool.input && tool.input.command ? (
          <span className="ml-1 text-(--color-text-secondary) truncate max-w-xs">
            {String(tool.input.command).slice(0, 80)}
          </span>
        ) : null}
        {"file_path" in tool.input && tool.input.file_path ? (
          <span className="ml-1 text-(--color-text-secondary) truncate max-w-xs">
            {sessionRelativePath(tool.input.file_path)}
          </span>
        ) : null}
        {"pattern" in tool.input && tool.input.pattern ? (
          <span className="ml-1 text-(--color-text-secondary) truncate max-w-xs">
            {String(tool.input.pattern)}
          </span>
        ) : null}
        {hasResult && (
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="ml-auto text-(--color-text-secondary) hover:text-(--color-text-primary) transition-colors shrink-0"
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
    <div className="flex items-center gap-1.5 mt-1 text-xs text-(--color-accent)">
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

// Configured Marked instance for rendering assistant messages as markdown.
// Uses highlight.js for fenced code blocks, matching the existing CodeBlock styling.
const chatMarked = new Marked({
  breaks: true,
  gfm: true,
  renderer: {
    code({ text, lang }) {
      const language = lang || "";
      const highlighted =
        language && hljs.getLanguage(language)
          ? hljs.highlight(text, { language }).value
          : hljs.highlightAuto(text).value;
      const langLabel = language
        ? `<div class="text-xs text-(--color-text-secondary) px-3 py-1 border-b border-(--color-border-primary)">${language}</div>`
        : "";
      return `<div class="my-2 rounded-md overflow-hidden bg-(--color-bg-secondary)">${langLabel}<pre class="p-3 overflow-x-auto text-xs leading-relaxed"><code class="hljs">${highlighted}</code></pre></div>`;
    },
  },
});

/** Render markdown text as HTML for assistant messages. */
function MarkdownContent({ text }: { text: string }) {
  const html = useMemo(() => {
    return chatMarked.parse(text, { async: false }) as string;
  }, [text]);

  return (
    <div
      className="prose dark:prose-invert prose-sm max-w-none"
      data-testid="markdown-content"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Hover tooltip that renders its content as markdown. Scrollable. */
function MarkdownTooltip({ content, children }: { content: string; children: React.ReactNode }) {
  const [visible, setVisible] = useState(false);
  const html = useMemo(() => chatMarked.parse(content, { async: false }) as string, [content]);

  return (
    <div className="relative" onMouseEnter={() => setVisible(true)} onMouseLeave={() => setVisible(false)}>
      {children}
      {visible && (
        <div className="absolute left-0 top-full z-50 pt-1">
          <div className="max-w-lg max-h-80 overflow-auto rounded-lg border border-(--color-border-secondary) bg-(--color-bg-elevated) shadow-xl p-3">
            <div
              className="prose dark:prose-invert prose-sm max-w-none text-xs"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>
        </div>
      )}
    </div>
  );
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
    <div className="my-2 rounded-md overflow-hidden bg-(--color-bg-secondary)">
      {language && (
        <div className="text-xs text-(--color-text-secondary) px-3 py-1 border-b border-(--color-border-primary)">
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
        className="w-full resize-none rounded-lg bg-(--color-accent) border border-(--color-border-focus) px-4 py-3 text-sm text-(--color-accent-text) placeholder-blue-300 focus:outline-none focus:ring-2 focus:ring-(--color-border-focus)"
      />
      <div className="flex justify-end gap-2 mt-1">
        <button
          onClick={onCancel}
          className="text-xs px-3 py-1 rounded bg-(--color-bg-tertiary) text-(--color-text-primary) hover:bg-(--color-bg-hover) transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => {
            const trimmed = text.trim();
            if (trimmed) onSave(trimmed);
          }}
          disabled={!text.trim()}
          className="text-xs px-3 py-1 rounded bg-(--color-accent) text-(--color-accent-text) hover:bg-(--color-accent-hover) disabled:opacity-50 transition-colors"
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

/** Render file attachment chips on a message bubble. */
function MessageFileAttachments({ files }: { files: ChatMessageFile[] }) {
  return (
    <div className="flex gap-1.5 flex-wrap mt-2" data-testid="message-files">
      {files.map((f, i) => {
        const fileName = f.path.split("/").pop() ?? f.path;
        const lineRange = f.startLine && f.endLine ? ` L${f.startLine}-${f.endLine}` : "";
        return (
          <span
            key={`${f.path}-${i}`}
            className="inline-flex items-center gap-1 px-2 py-0.5 bg-white/10 border border-white/20 rounded text-xs"
            title={f.path}
          >
            <svg className="w-3 h-3 shrink-0 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
            <span className="truncate max-w-[150px]">{fileName}</span>
            {lineRange && <span className="opacity-60">{lineRange}</span>}
          </span>
        );
      })}
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

export function MessageList({
  messages,
  isLoading,
  activity,
  searchMatches,
  currentMatch,
  onEditMessage,
  onAnswerQuestion,
  onRollback,
}: {
  messages: ChatMessage[];
  isLoading: boolean;
  activity?: StreamingActivity;
  searchMatches?: SearchMatch[];
  currentMatch?: SearchMatch;
  onEditMessage?: (messageIndex: number, newText: string) => void;
  onAnswerQuestion?: (toolUseId: string, answers: Record<string, string>) => void;
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

  // Cancel editing when loading starts (message was sent)
  useEffect(() => {
    if (isLoading) setEditingIndex(null);
  }, [isLoading]);

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

      {buildVisualElements(messages).map((el) => {
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
            const description = String(tool.input.description ?? "Running task...");
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
          const skillName = String(tool.input.skill ?? "unknown");
          const args = tool.input.args ? String(tool.input.args) : "";
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
                <button
                  onClick={() => setEditingIndex(i)}
                  className="p-1 rounded text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover) transition-colors"
                  title="Edit message"
                  aria-label="Edit message"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                </button>
                <button
                  onClick={() => onEditMessage?.(i, msg.text)}
                  className="p-1 rounded text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover) transition-colors"
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
                          isQuestionDisabled={questionDisabled}
                        />
                      );
                    })}
                  </div>
                );
              })()}

              {msg.streaming && (
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
