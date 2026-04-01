import { useMemo } from "react";
import hljs from "highlight.js";
import { Marked } from "marked";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "./ui/tooltip.js";
import type { MessageSegment } from "./MessageList.js";

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
      return `<div class="my-2 rounded-md overflow-hidden bg-(--color-bg-secondary) w-0 min-w-full">${langLabel}<pre class="p-3 overflow-x-auto text-xs leading-relaxed"><code class="hljs">${highlighted}</code></pre></div>`;
    },
  },
});

/** Render markdown text as HTML for assistant messages. */
export function MarkdownContent({ text }: { text: string }) {
  const html = useMemo(() => {
    return chatMarked.parse(text, { async: false });
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
export function MarkdownTooltip({ content, children }: { content: string; children: React.ReactNode }) {
  const html = useMemo(() => chatMarked.parse(content, { async: false }), [content]);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div>{children}</div>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" className="max-w-lg max-h-80 overflow-auto p-3">
          <div
            className="prose dark:prose-invert prose-sm max-w-none text-xs"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Syntax-highlighted fenced code block. */
export function CodeBlock({ code, language }: { code: string; language: string }) {
  const html = useMemo(() => {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language }).value;
    }
    return hljs.highlightAuto(code).value;
  }, [code, language]);

  return (
    <div className="my-2 rounded-md overflow-hidden bg-(--color-bg-secondary) w-0 min-w-full">
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
