import { useMemo, useState, useCallback } from "react";
import hljs from "highlight.js";
import { Marked } from "marked";
import { CopyIcon, CheckIcon } from "@phosphor-icons/react";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "./ui/tooltip.js";
import { ICON_SIZE } from "../design-tokens.js";
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
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const titleAttr = title ? ` title="${title}"` : "";
      return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
    code({ text, lang }) {
      // Fallback HTML rendering for code blocks marked encounters directly
      // (e.g. indented code). The primary path in MarkdownContent splits
      // fenced blocks into React CodeBlock components with a Copy button —
      // this string version has no copy affordance because marked can't
      // host React handlers, but matches the same visual styling.
      const language = lang || "";
      const highlighted =
        language && hljs.getLanguage(language)
          ? hljs.highlight(text, { language }).value
          : hljs.highlightAuto(text).value;
      const langLabel = `<div class="text-xs text-(--color-text-secondary) px-3 py-1 border-b border-(--color-border-primary)">${language || "code"}</div>`;
      return `<div class="my-2 rounded-md overflow-hidden bg-(--color-bg-secondary) w-0 min-w-full">${langLabel}<pre class="p-4 overflow-x-auto text-xs leading-relaxed"><code class="hljs">${highlighted}</code></pre></div>`;
    },
  },
});

/**
 * Render markdown text as HTML for assistant messages.
 *
 * Fenced code blocks are split out of the marked render path and rendered as
 * React `CodeBlock` components instead. This is what gives them their per-block
 * "Copy" button (a marked HTML string can't host React event handlers).
 * Non-code text between blocks is still rendered through marked so paragraphs,
 * lists, headings, etc. work normally.
 */
export function MarkdownContent({ text }: { text: string }) {
  const segments = useMemo(() => parseMessageSegments(text), [text]);

  return (
    <div
      className="prose dark:prose-invert prose-sm max-w-none"
      data-testid="markdown-content"
    >
      {segments.map((seg, idx) => {
        if (seg.type === "code") {
          return (
            <CodeBlock
              key={idx}
              code={seg.content}
              language={seg.language}
            />
          );
        }
        const html = chatMarked.parse(seg.content, { async: false });
        return <div key={idx} dangerouslySetInnerHTML={{ __html: html }} />;
      })}
    </div>
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

/** Syntax-highlighted fenced code block with a header and "Copy" button. */
export function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);

  const html = useMemo(() => {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language }).value;
    }
    return hljs.highlightAuto(code).value;
  }, [code, language]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Browsers may deny clipboard access (insecure context, permission
      // policy). Silently swallow so the chat doesn't crash — the user can
      // still select-and-copy manually from the block.
    }
  }, [code]);

  return (
    <div className="my-2 rounded-md overflow-hidden bg-(--color-bg-secondary) w-0 min-w-full">
      <div className="flex items-center justify-between gap-2 px-3 py-1 border-b border-(--color-border-primary)">
        <span className="text-xs text-(--color-text-secondary) truncate">
          {language || "code"}
        </span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          aria-label={copied ? "Copied" : "Copy code"}
          className="inline-flex items-center gap-1 text-xs text-(--color-text-tertiary) hover:text-(--color-text-primary) transition-colors rounded px-1.5 py-0.5 shrink-0"
        >
          {copied ? <CheckIcon size={ICON_SIZE.XS} /> : <CopyIcon size={ICON_SIZE.XS} />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="p-4 overflow-x-auto text-xs leading-relaxed">
        <code
          className="hljs"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </pre>
    </div>
  );
}
