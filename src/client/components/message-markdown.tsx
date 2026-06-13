import { useState, useCallback, useMemo, memo } from "react";
import hljs from "highlight.js";
import { CopyIcon, CheckIcon } from "@phosphor-icons/react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import type { Element as HastElement, Text as HastText } from "hast";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "./ui/tooltip.js";
import { ICON_SIZE } from "../design-tokens.js";
import type { MessageSegment } from "./MessageList.js";
import { parseRepoFileLink } from "../utils/repo-file-link.js";
import { parseTrackerIssueLink } from "../utils/tracker-link.js";
import { remarkLinkifyPaths } from "../utils/linkify-paths.js";
import { useFileStore } from "../stores/file-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useIssuesStore } from "../stores/issues-store.js";
import { useUiStore } from "../stores/ui-store.js";

/**
 * Renders a markdown link. Three branches, in priority order:
 *
 *  1. **Tracker issue URLs** (Linear/GitHub issue URLs, or the GitHub
 *     `owner/repo#N` short form) open the in-app Issues viewer when that tracker
 *     is connected — "inline beats link-out" (CLAUDE.md §1/§2). When the tracker
 *     is NOT connected we fall through to the default new-tab navigation (the
 *     escape hatch). The anchor's `href` is the resolved absolute issue URL so
 *     that fallback works even for the short form. This is checked *before* the
 *     repo-file branch because the short form (`owner/repo#42`) would otherwise
 *     be misread by `parseRepoFileLink` as the path `owner/repo` at line 42.
 *  2. **Repo file links** (relative paths, optionally `:line` suffixed) open the
 *     in-app file preview modal — a bare `target="_blank"` would resolve the
 *     relative href against `/sessions/<id>` and 404.
 *  3. **Everything else** keeps the default new-tab behaviour.
 *
 * Store reads happen inside the click handler via `getState()` (not a hook
 * subscription) so this component stays render-pure and doesn't defeat the
 * `MarkdownContent` memo, matching the repo-file branch.
 */
function MarkdownLink({
  href,
  title,
  children,
}: {
  href?: string;
  title?: string;
  children?: React.ReactNode;
}) {
  const issueLink = parseTrackerIssueLink(href);
  if (issueLink) {
    const openIssueInApp = (e: React.MouseEvent) => {
      const connected =
        useIssuesStore.getState().trackers.find((t) => t.id === issueLink.tracker)?.configured ??
        false;
      // Tracker not connected (or its config is still cold) — let the browser
      // follow the absolute href to the upstream issue in a new tab.
      if (!connected) return;
      e.preventDefault();
      useUiStore.getState().setRightTab("issues");
      useUiStore.getState().setMobilePanel("preview");
      void useIssuesStore.getState().openIssue({
        tracker: issueLink.tracker,
        ...(issueLink.issueId !== undefined ? { id: issueLink.issueId } : {}),
        identifier: issueLink.identifier,
        url: issueLink.url,
      });
    };
    return (
      <a
        href={issueLink.url}
        title={title}
        target="_blank"
        rel="noopener noreferrer"
        onClick={openIssueInApp}
        className="cursor-pointer"
      >
        {children}
      </a>
    );
  }

  const repoLink = parseRepoFileLink(href);
  if (repoLink) {
    const openPreview = (e: React.MouseEvent) => {
      e.preventDefault();
      const sessionId = useSessionStore.getState().sessionId;
      if (!sessionId) return;
      void useFileStore.getState().openPreview(sessionId, repoLink.path, { line: repoLink.line });
    };
    return (
      <a href={href} title={title} onClick={openPreview} className="cursor-pointer">
        {children}
      </a>
    );
  }
  return (
    <a href={href} title={title} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

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
 * - Repo file links → open the in-app file preview modal (see `MarkdownLink`).
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
      <MarkdownLink href={href} title={title}>
        {children}
      </MarkdownLink>
    );
  },
  // Wide tables (often produced by code-analysis prompts) would otherwise push
  // their containing message bubble past the viewport on mobile. The
  // `w-0 min-w-full` pair pins the wrapper to its parent's width without
  // letting the table expand it, and `overflow-x-auto` keeps the scroll local.
  table({ children }) {
    return (
      <div className="w-0 min-w-full overflow-x-auto my-2">
        <table>{children}</table>
      </div>
    );
  },
};

// `remarkLinkifyPaths` runs last so it sees GFM's autolinked URLs as `link`
// nodes (which it skips) and only touches remaining plain text. It turns bare
// `dir/file.ext` references in prose into in-app file-preview links.
const remarkPlugins = [remarkGfm, remarkBreaks, remarkLinkifyPaths];

/**
 * Render markdown text for assistant messages, PR bodies, plan approval, and
 * subagent reports. Backed by `react-markdown`, so streaming updates diff into
 * existing text nodes instead of replacing whole subtrees — the user's text
 * selection survives token-by-token streaming without the freeze hack that
 * used to live in `MessageList`.
 *
 * `memo`'d on `text`: `react-markdown` re-runs the full remark pipeline
 * (micromark parse → mdast → hast → React elements) on every render, and the
 * `MessageList` re-renders on every streamed token. Without this gate, every
 * message in the transcript re-parsed its markdown on each token of the
 * *currently streaming* message — O(messages × tokens) parsing that pinned the
 * main thread (the dominant cost in the 2026-06 perf trace). `remarkPlugins`
 * and `markdownComponents` are module-level constants, so the parse output
 * depends only on `text`; a shallow prop compare is exactly correct.
 */
export const MarkdownContent = memo(({ text }: { text: string }) => {
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
});

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

/**
 * Syntax-highlighted fenced code block with a header and "Copy" button.
 *
 * `memo`'d on `{ code, language }` so a growing transcript doesn't re-run
 * `hljs.highlight` for every already-rendered block on each streamed token —
 * the inner `useMemo` only protects a single render, the `memo` boundary
 * skips the render entirely when the block's content is unchanged.
 */
export const CodeBlock = memo(({ code, language }: { code: string; language: string }) => {
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
    <div className="not-prose my-2 rounded-md overflow-hidden bg-(--color-bg-secondary) w-0 min-w-full">
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
      <pre className="px-3 py-1 overflow-x-auto text-xs leading-relaxed">
        <code
          className="hljs"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </pre>
    </div>
  );
});
