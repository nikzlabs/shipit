import { useMemo, useEffect, useRef } from "react";
import hljs from "highlight.js";
import "highlight.js/styles/github-dark.css";
import { DiffBlock } from "./DiffBlock.js";
import {
  ThinkingIndicator,
  TypingDots,
  ToolSpinner,
  type StreamingActivity,
} from "./StreamingIndicator.js";
import type { SearchMatch } from "../hooks/useSearch.js";

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  toolUse?: ToolUseBlock[];
  streaming?: boolean;
  /** When true, this message represents an error (CLI crash, WS drop, etc.) */
  isError?: boolean;
}

function ToolUseItem({ tool, isLast, isStreaming }: { tool: ToolUseBlock; isLast: boolean; isStreaming: boolean }) {
  // Show a spinner on the last tool when the message is still streaming
  const inProgress = isLast && isStreaming;

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

  // Fallback: compact one-liner for non-file tools
  return (
    <div className="text-xs text-gray-400 bg-gray-900 rounded px-2 py-1 font-mono flex items-center gap-2">
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
    <div className="my-2 rounded-md overflow-hidden bg-gray-950">
      {language && (
        <div className="text-xs text-gray-500 px-3 py-1 border-b border-gray-700/50">
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

export function MessageList({
  messages,
  isLoading,
  activity,
  searchMatches,
  currentMatch,
}: {
  messages: ChatMessage[];
  isLoading: boolean;
  activity?: StreamingActivity;
  searchMatches?: SearchMatch[];
  currentMatch?: SearchMatch;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const currentMatchRef = useRef<HTMLElement | null>(null);

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

  return (
    <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-3 sm:py-4 space-y-3 sm:space-y-4">
      {messages.length === 0 && !isLoading && (
        <div className="flex items-center justify-center h-full text-gray-500">
          <p>Send a message to start coding with Claude.</p>
        </div>
      )}

      {messages.map((msg, i) => {
        const msgMatches = matchesByMessage.get(i) ?? [];
        const segments = parseMessageSegments(msg.text);
        const hasCodeBlocks = segments.some((s) => s.type === "code");

        return (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-2xl rounded-lg px-4 py-3 text-sm ${
                !hasCodeBlocks ? "whitespace-pre-wrap" : ""
              } ${
                msg.isError
                  ? "bg-red-900/60 text-red-200 border border-red-700/50"
                  : msg.role === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-gray-800 text-gray-100"
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

              {msg.toolUse && msg.toolUse.length > 0 && (
                <div className="mt-2 space-y-1">
                  {msg.toolUse.map((tool, toolIdx) => (
                    <ToolUseItem
                      key={tool.id}
                      tool={tool}
                      isLast={toolIdx === msg.toolUse!.length - 1}
                      isStreaming={!!msg.streaming}
                    />
                  ))}
                </div>
              )}

              {msg.streaming && (
                <span className="inline-flex items-center ml-1 align-middle">
                  <TypingDots />
                </span>
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
