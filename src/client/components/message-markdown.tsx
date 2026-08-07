import { useMemo, memo } from "react";
import hljs from "highlight.js";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import type { Element as HastElement, Text as HastText } from "hast";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "./ui/tooltip.js";
import { CopyButton } from "./ui/copy-button.js";
import { ICON_SIZE } from "../design-tokens.js";
import type { MessageSegment } from "./MessageList.js";
import type { OpenIssueRef } from "../stores/issues-store.js";
import { parseRepoFileLink } from "../utils/repo-file-link.js";
import { parseTrackerIssueLink } from "../utils/tracker-link.js";
import { remarkLinkifyPaths } from "../utils/linkify-paths.js";
import { remarkLinkifyIssues, ISSUE_LINK_SCHEME } from "../utils/linkify-issues.js";
import { useFileStore } from "../stores/file-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { toTrackerDestinations, trackerDestinations, useIssuesStore } from "../stores/issues-store.js";
import { resolveIssueRef } from "../../server/shared/issue-ref-resolution.js";
import { useUiStore } from "../stores/ui-store.js";

/**
 * Open an issue in the inline Issues viewer. Both the tracker-URL link branch
 * and the bare-key `IssueBadge` route through here so they share one behaviour:
 * select the Issues tab in the workspace panel AND — the part that matters on
 * mobile — flip the mobile layout from the chat column to the workspace
 * (`preview`) column, since on a phone the Issues tab is only visible there.
 */
function openIssueInPanel(ref: OpenIssueRef): void {
  useUiStore.getState().setRightTab("issues");
  useUiStore.getState().setMobilePanel("preview");
  void useIssuesStore.getState().openIssue(ref);
}

/**
 * An inline issue badge for a bare reference the agent mentioned in prose —
 * a bare key (`SHI-43`) or a docs/248 name form (`roadmap#SHI-319`,
 * `planning#57`) — produced by `remarkLinkifyIssues`, which wraps the whole
 * token in a sentinel `shipit-issue:TOKEN` link. Clicking opens the issue in the
 * inline Issues viewer via {@link openIssueInPanel}.
 *
 * **The gate lives here, not in the parse**, and it is the *shared* resolver
 * (`resolveIssueRef`) over the repository's declared destinations — the same one
 * the markdown-href branch, the doc `issue:` chips and the `shipit issue` shim
 * use. A reference-shaped token collides with everyday prose (`GPT-4`, `UTF-8`,
 * `PR#3`), so resolution is what decides an issue from noise, and routing it
 * through the shared implementation is what keeps docs/248 req 11's two
 * fail-closed rules in one place: a token naming **no** declared destination and
 * a token matching **more than one** both render as their raw text — never as a
 * badge pointing at a guess. (An earlier gate here compared the token's team
 * prefix against the connected Linear workspace's bound team key. That test was
 * Linear-specific — it had no answer at all for `planning#57` — and reproducing
 * the ambiguity rule by hand is exactly how docs/248 shipped a bug where a key
 * declared by two trackers opened the first match.)
 *
 * The tracker must also be **connected**: a badge has no external escape hatch
 * (unlike the href branch, which falls back to a new tab), so a click on a
 * declared-but-unconfigured tracker would open the panel onto an error. Not
 * connected → plain text, same as undeclared.
 *
 * This is the one render-time store read in this module (the link branches read
 * in their click handlers instead). It subscribes to the `trackers` array
 * itself — identity-stable across reads — and derives destinations + resolution
 * in a `useMemo`, so the badge only re-renders when the tracker set changes and
 * the `MarkdownContent` memo guarding streaming re-parses is untouched.
 *
 * Styling keeps the badge within the surrounding line box — `text-[0.85em]`
 * with `leading-none` and only horizontal padding — so it reads as a pill
 * without growing the line height (an explicit requirement: badges must not
 * push prose lines apart).
 */
function IssueBadge({ token, children }: { token: string; children?: React.ReactNode }) {
  const trackers = useIssuesStore((s) => s.trackers);
  const target = useMemo(() => {
    const resolution = resolveIssueRef(token, toTrackerDestinations(trackers));
    if (!resolution.ok) return null;
    const ref = resolution.ref;
    if (!trackers.find((t) => t.id === ref.tracker)?.configured) return null;
    return ref;
  }, [token, trackers]);

  // Unresolvable, ambiguous, or not connected — degrade to exactly the original
  // text (`children` is the leaf the plugin split out, so an inline-code
  // reference stays monospace and a prose one stays prose).
  if (!target) return <>{children}</>;

  return (
    <button
      type="button"
      title={`Open ${target.identifier}`}
      onClick={() =>
        openIssueInPanel({
          tracker: target.tracker,
          id: target.issueId,
          // req 15 — the destination's name form, whatever form was written.
          identifier: target.identifier,
          ...(target.url ? { url: target.url } : {}),
        })
      }
      className="inline-flex items-center align-middle rounded px-1 text-[0.85em] font-mono font-medium leading-none border border-(--color-accent)/30 bg-(--color-accent)/10 text-(--color-accent) hover:bg-(--color-accent)/20 transition-colors cursor-pointer"
    >
      {token}
    </button>
  );
}

/**
 * Renders a markdown link. Branches, in priority order:
 *
 *  1. **Bare issue references** (`shipit-issue:TOKEN`, minted by
 *     `remarkLinkifyIssues` — a bare key or a docs/248 name form) render as an
 *     inline {@link IssueBadge} that opens the in-app Issues viewer.
 *  2. **Tracker issue URLs** (Linear/GitHub issue URLs, or the GitHub
 *     `owner/repo#N` short form) open the in-app Issues viewer when that tracker
 *     is connected — "inline beats link-out" (CLAUDE.md §1/§2). When the tracker
 *     is NOT connected we fall through to the default new-tab navigation (the
 *     escape hatch). The anchor's `href` is the resolved absolute issue URL so
 *     that fallback works even for the short form. This is checked *before* the
 *     repo-file branch because the short form (`owner/repo#42`) would otherwise
 *     be misread by `parseRepoFileLink` as the path `owner/repo` at line 42.
 *  3. **Repo file links** (relative paths, optionally `:line` suffixed) open the
 *     in-app file preview modal — a bare `target="_blank"` would resolve the
 *     relative href against `/sessions/<id>` and 404. This branch renders an
 *     anchor with **no `href` at all**: the click handler is the whole
 *     behaviour, and a repo file has no URL of its own (the preview is modal
 *     state, not a route). Keeping a relative `href` for styling made the
 *     browser advertise a URL that doesn't exist — `/session/src/foo.ts` in the
 *     status bar on hover, and a real 404 navigation via middle-click,
 *     ⌘/Ctrl-click, or "Open link in new tab". `role="button"` + `tabIndex`
 *     restore the keyboard affordance the missing `href` takes away, and the
 *     `a` *element* still picks up prose link styling (Tailwind Typography
 *     targets the bare `a` selector, which does not require `href`).
 *  4. **Everything else** keeps the default new-tab behaviour.
 *
 * Store reads happen inside the click handler via `getState()` (not a hook
 * subscription) so this component stays render-pure and doesn't defeat the
 * `MarkdownContent` memo, matching the repo-file branch. (The `IssueBadge`
 * branch is the documented exception — see its note.)
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
  if (href?.startsWith(ISSUE_LINK_SCHEME)) {
    return <IssueBadge token={href.slice(ISSUE_LINK_SCHEME.length)}>{children}</IssueBadge>;
  }

  // docs/248 — the destinations are read at render time from the tracker list
  // the store already holds, so an href only becomes an in-app link when it
  // resolves to something this session's repository actually declares (req 11).
  const issueLink = parseTrackerIssueLink(href, trackerDestinations());
  if (issueLink) {
    const openIssueInApp = (e: React.MouseEvent) => {
      const connected =
        useIssuesStore.getState().trackers.find((t) => t.id === issueLink.tracker)?.configured ??
        false;
      // Tracker not connected (or its config is still cold) — let the browser
      // follow the absolute href to the upstream issue in a new tab.
      if (!connected) return;
      e.preventDefault();
      openIssueInPanel({
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
    const openPreview = () => {
      const sessionId = useSessionStore.getState().sessionId;
      if (!sessionId) return;
      void useFileStore.getState().openPreview(sessionId, repoLink.path, { line: repoLink.line });
    };
    const onKeyDown = (e: React.KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      openPreview();
    };
    return (
      <a
        // No `href` — see branch 3 in the doc comment above.
        role="button"
        tabIndex={0}
        title={title ?? `Open ${href}`}
        onClick={openPreview}
        onKeyDown={onKeyDown}
        className="cursor-pointer"
      >
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

// `remarkLinkifyPaths` / `remarkLinkifyIssues` run last so they see GFM's
// autolinked URLs as `link` nodes (which they skip) and only touch remaining
// plain text. The first turns bare `dir/file.ext` references into in-app
// file-preview links; the second turns bare issue references (`SHI-43`,
// `roadmap#SHI-43`, `planning#57`) into in-app issue badges (gated at render by
// the declared-destination resolver — see `IssueBadge`).
const remarkPlugins = [remarkGfm, remarkBreaks, remarkLinkifyPaths, remarkLinkifyIssues];

// `remarkLinkifyIssues` mints `shipit-issue:TOKEN` hrefs; react-markdown's default
// `urlTransform` would strip that unknown scheme to "" (losing the token), so we
// pass our scheme through and delegate everything else to the default sanitiser
// (which still filters `javascript:`, `data:`, etc.).
function urlTransform(url: string): string {
  if (url.startsWith(ISSUE_LINK_SCHEME)) return url;
  return defaultUrlTransform(url);
}

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
        urlTransform={urlTransform}
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
              urlTransform={urlTransform}
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
  const html = useMemo(() => {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language }).value;
    }
    return hljs.highlightAuto(code).value;
  }, [code, language]);

  return (
    <div className="not-prose my-2 rounded-md overflow-hidden bg-(--color-bg-secondary) w-0 min-w-full">
      <div className="flex items-center justify-between gap-2 px-3 py-1 border-b border-(--color-border-primary)">
        <span className="text-xs text-(--color-text-secondary) truncate">
          {language || "code"}
        </span>
        <CopyButton
          text={code}
          timeout={1500}
          iconSize={ICON_SIZE.XS}
          aria-label="Copy code"
          className="text-(--color-text-tertiary) hover:text-(--color-text-primary) px-1.5 shrink-0"
        />
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
