import { useState, useCallback, useMemo } from "react";
import hljs from "highlight.js";
import { CopyIcon, CheckIcon } from "@phosphor-icons/react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import type { Element as HastElement, Text as HastText } from "hast";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "./ui/tooltip.js";
import { ICON_SIZE } from "../design-tokens.js";
import type { MessageSegment } from "./MessageList.js";

/**
 * Parse message text into alternating text and fenced code block segments.
 * Each segment tracks its character offset in the original text so that
 * search-match positions can be mapped back correctly. Used by `MessageList`
 * to split non-markdown messages (user messages with code blocks) so the
 * `CodeBlock` Copy affordance lines up with the surrounding `HighlightedText`.
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
 * Pull the raw fenced-code text out of the hast `<code>` child of a `<pre>`.
 * react-markdown turns ```lang … ``` into `pre > code(.language-lang) > text`;
 * we read the text node directly rather than stringifying React children so
 * whitespace, leading hashes, etc. survive verbatim.
 */
function extractCodeFromPreNode(node: HastElement | undefined): { code: string; language: string } | null {
  if (node?.type !== "element" || node.tagName !== "pre") return null;
  const codeEl = node.children.find(
    (c): c is HastElement => c.type === "element" && c.tagName === "code",
  );
  if (!codeEl) return null;
  const classNames = codeEl.properties?.className;
  const classList = Array.isArray(classNames)
    ? classNames.map(String)
    : classNames !== undefined && classNames !== null
      ? [String(classNames)]
      : [];
  const langClass = classList.find((cn) => cn.startsWith("language-"));
  const language = langClass ? langClass.slice("language-".length) : "";
  const text = codeEl.children
    .filter((c): c is HastText => c.type === "text")
    .map((c) => c.value)
    .join("")
    .replace(/\n$/, "");
  return { code: text, language };
}

/**
 * Component overrides shared by every markdown surface. They centralise:
 * - Fenced code blocks → React `CodeBlock` (Copy button + hljs styling). We
 *   intercept at `pre` so inline `<code>` keeps its lightweight inline render.
 * - External links → `target="_blank"` with `rel="noopener noreferrer"`.
 * `react-markdown`'s default `urlTransform` already filters dangerous protocols
 * (`javascript:`, `data:`, etc.), so we don't need to repeat that check here.
 */
export const markdownComponents: Components = {
  pre({ node, children }) {
    const extracted = extractCodeFromPreNode(node);
    if (extracted) {
      return <CodeBlock code={extracted.code} language={extracted.language} />;
    }
    return <pre>{children}</pre>;
  },
  a({ href, title, children }) {
    return (
      <a href={href} title={title} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
};

const remarkPlugins = [remarkGfm, remarkBreaks];

/**
 * Render markdown text for assistant messages, PR bodies, plan approval, and
 * subagent reports. Backed by `react-markdown`, so streaming updates diff into
 * existing text nodes instead of replacing whole subtrees — the user's text
 * selection survives token-by-token streaming without the freeze hack that
 * used to live in `MessageList`.
 */
export function MarkdownContent({ text }: { text: string }) {
  return (
    <div
      className="prose dark:prose-invert prose-sm max-w-none"
      data-testid="markdown-content"
    >
      <Markdown
        remarkPlugins={remarkPlugins}
        components={markdownComponents}
        skipHtml
      >
        {text}
      </Markdown>
    </div>
  );
}

/** Hover tooltip that renders its content as markdown. Scrollable. */
export function MarkdownTooltip({ content, children }: { content: string; children: React.ReactNode }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div>{children}</div>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" className="max-w-lg max-h-80 overflow-auto p-3">
          <div className="prose dark:prose-invert prose-sm max-w-none text-xs">
            <Markdown
              remarkPlugins={remarkPlugins}
              components={markdownComponents}
              skipHtml
            >
              {content}
            </Markdown>
          </div>
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
