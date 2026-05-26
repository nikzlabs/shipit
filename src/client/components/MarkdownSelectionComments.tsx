// eslint-disable-next-line no-restricted-imports -- useEffect: selection listener + DOM measurement, useRef: rendered body container, useLayoutEffect: position the floating button against the latest selection rect
import { useState, useMemo, useCallback, useEffect, useRef, useLayoutEffect, memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { unified } from "unified";
import remarkParse from "remark-parse";
import type { Root, RootContent } from "mdast";
import { ChatTeardropTextIcon, PencilSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { Badge, type BadgeProps } from "./ui/badge.js";
import { parseFrontmatter, type ParsedFrontmatter } from "../utils/markdown-frontmatter.js";
import type { DocPriority, DocStatus } from "../../server/shared/types.js";
import { markdownComponents } from "./message-markdown.js";

const CONTEXT_CHARS = 50;
const HIGHLIGHT_NAME = "shipit-pending-comment";

export interface SelectionCommentData {
  id: string;
  quotedText: string;
  contextBefore: string;
  contextAfter: string;
  text: string;
  source?: "human" | "ai";
}

/**
 * Per-block top-margin size. We render each top-level mdast child in its own
 * `.prose` container; Tailwind Typography's `> :first-child { margin-top: 0 }`
 * rule zeros out the prose heading/paragraph margins inside it, so we restore
 * vertical rhythm with a wrapper margin chosen by block type. Headings get the
 * largest gap (section break), paragraphs get the smallest (tight inline
 * paragraph-after-content), everything else sits in between.
 */
type BlockSpacing = "lg" | "md" | "sm";

interface MarkdownBlock {
  /** Verbatim slice of the original markdown source that produced this block. */
  source: string;
  /** Flattened text — used to match selection-anchored comments to a block. */
  textContent: string;
  /** Top margin to apply to this block's wrapper (suppressed on the first block). */
  topSpacing: BlockSpacing;
}

const TOP_MARGIN_CLASS: Record<BlockSpacing, string> = {
  lg: "mt-6",
  md: "mt-4",
  sm: "mt-2",
};

/**
 * Pick the wrapper top-margin for a top-level mdast block. Headings get a
 * section-break gap (depth 1–2 the largest, deeper headings smaller).
 * Paragraphs get the tightest gap so a heading + paragraph reads as a pair.
 * Lists, code, quotes, tables, and rules sit in the middle.
 */
function topSpacingFor(node: RootContent): BlockSpacing {
  if (node.type === "heading") {
    return node.depth <= 2 ? "lg" : "md";
  }
  if (node.type === "paragraph") return "sm";
  return "md";
}

/**
 * Shared remark plugin stack for the docs viewer. `remark-gfm` is the superset
 * we render (tables, task lists, strikethrough). We deliberately don't add
 * `rehype-slug` / `rehype-autolink-headings` — the docs viewer has no UI for
 * deep-linking to sections, so the heading ids and wrapping anchors would
 * just be dead DOM weight.
 */
const remarkPluginsDocs = [remarkGfm];

/**
 * Memoised wrapper around a single rendered markdown block. The wrapper exists
 * so selection-anchored comment positioning has a stable container per
 * top-level block: `offsetWithin` walks text nodes from the document root and
 * `commentsByBlock` slots each comment after the block whose flat text
 * contains it. We memoise on the source slice so streaming-style re-renders of
 * an unrelated block don't reconcile this one's text nodes — the same
 * property that lets the chat survive without the freeze hack now keeps the
 * docs viewer's mid-selection rendering stable too.
 */
const MarkdownBlock = memo(({ source }: { source: string }) => (
  <div className="prose dark:prose-invert prose-sm max-w-none">
    <Markdown
      remarkPlugins={remarkPluginsDocs}
      components={markdownComponents}
      skipHtml
    >
      {source}
    </Markdown>
  </div>
));
MarkdownBlock.displayName = "MarkdownBlock";

/** Flatten an mdast subtree to a plain text string for comment matching. */
function mdastToText(node: RootContent | Root): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node && Array.isArray(node.children)) {
    return node.children.map(mdastToText).join("");
  }
  return "";
}

const docsParser = unified().use(remarkParse).use(remarkGfm);

/**
 * Split markdown into top-level blocks by parsing to mdast and slicing the
 * original source by each child's recorded offsets. Each slice round-trips
 * cleanly through react-markdown — re-parsing a top-level paragraph, heading,
 * list, or fenced code block in isolation produces the same render as parsing
 * the whole document, so block-by-block rendering preserves layout while
 * giving us stable wrappers to anchor comments against.
 */
function splitIntoTopLevelBlocks(content: string): MarkdownBlock[] {
  const tree = docsParser.parse(content);
  const blocks: MarkdownBlock[] = [];
  for (const child of tree.children) {
    const start = child.position?.start.offset ?? 0;
    const end = child.position?.end.offset ?? content.length;
    blocks.push({
      source: content.slice(start, end),
      textContent: mdastToText(child),
      topSpacing: topSpacingFor(child),
    });
  }
  if (blocks.length === 0 && content.trim() !== "") {
    blocks.push({ source: content, textContent: content, topSpacing: "md" });
  }
  return blocks;
}

/**
 * Locate a selection-anchored comment inside the flat text of a block. Mirrors
 * the server's `locateSelection`: prefers an occurrence bracketed by the saved
 * `contextBefore`/`contextAfter`, otherwise falls back to the first occurrence.
 * Returns `-1` if the quoted text isn't found.
 */
function locateInBlock(
  text: string,
  comment: Pick<SelectionCommentData, "quotedText" | "contextBefore" | "contextAfter">,
): number {
  if (comment.quotedText === "") return -1;
  let from = 0;
  let firstMatch = -1;
  while (from <= text.length) {
    const idx = text.indexOf(comment.quotedText, from);
    if (idx === -1) break;
    if (firstMatch === -1) firstMatch = idx;
    const before = text.slice(Math.max(0, idx - comment.contextBefore.length), idx);
    const after = text.slice(
      idx + comment.quotedText.length,
      idx + comment.quotedText.length + comment.contextAfter.length,
    );
    if (
      (comment.contextBefore === "" || before.endsWith(comment.contextBefore)) &&
      (comment.contextAfter === "" || after.startsWith(comment.contextAfter))
    ) {
      return idx;
    }
    from = idx + 1;
  }
  return firstMatch;
}

/**
 * Walk text nodes inside `root` and compute the character offset of
 * (node, offsetInNode) in the concatenated text content.
 */
function offsetWithin(root: Node, node: Node, offsetInNode: number): number {
  let offset = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const text = walker.currentNode as Text;
    if (text === node) {
      return offset + offsetInNode;
    }
    offset += text.data.length;
  }
  // Fallback: if the node isn't under root (shouldn't happen for valid selections).
  return -1;
}

/**
 * Frontmatter header — unchanged from the previous section-anchored layout, since
 * frontmatter rendering is orthogonal to the comment anchoring model.
 */
const STATUS_BADGE: Record<DocStatus, { label: string; variant: BadgeProps["variant"] }> = {
  "in-progress": { label: "In Progress", variant: "warning" },
  "planned": { label: "Planned", variant: "info" },
  "paused": { label: "Paused", variant: "default" },
  "done": { label: "Done", variant: "success" },
  "rejected": { label: "Rejected", variant: "error" },
};

const PRIORITY_BADGE: Record<DocPriority, { label: string; variant: BadgeProps["variant"] }> = {
  high: { label: "High priority", variant: "error" },
  medium: { label: "Med priority", variant: "warning" },
  low: { label: "Low priority", variant: "default" },
};

function FrontmatterHeader({ fm }: { fm: ParsedFrontmatter }) {
  const status = fm.status ? STATUS_BADGE[fm.status] : null;
  const priority = fm.priority ? PRIORITY_BADGE[fm.priority] : null;
  const hasBadges = !!status || !!priority || !!fm.customStatus;
  const hasContent = hasBadges || !!fm.description || fm.extras.length > 0;
  if (!hasContent) return null;

  return (
    <div className="mb-4 pb-4 border-b border-(--color-border-secondary) space-y-2">
      {hasBadges && (
        <div className="flex flex-wrap items-center gap-2">
          {status && <Badge variant={status.variant}>{status.label}</Badge>}
          {!status && fm.customStatus && <Badge variant="default">{fm.customStatus}</Badge>}
          {priority && <Badge variant={priority.variant}>{priority.label}</Badge>}
        </div>
      )}
      {fm.description && (
        <p className="text-sm text-(--color-text-secondary) italic">{fm.description}</p>
      )}
      {fm.extras.length > 0 && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
          {fm.extras.map((entry) => (
            <div key={entry.key} className="contents">
              <dt className="text-(--color-text-tertiary) font-medium">{entry.key}</dt>
              <dd className="text-(--color-text-secondary) font-mono break-all">{entry.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export interface MarkdownSelectionCommentsProps {
  content: string;
  comments: SelectionCommentData[];
  onAddComment: (quotedText: string, contextBefore: string, contextAfter: string, text: string) => void;
  onEditComment: (commentId: string, text: string) => void;
  onDeleteComment: (commentId: string) => void;
  /**
   * docs/151 — when true, hides the floating add-comment button and passes
   * no-op edit/delete callbacks so the comments render but the user can't
   * mutate them. Used by `FilePreviewModal` in agent-review snapshot mode.
   */
  readOnly?: boolean;
}

function CommentInput({
  onSubmit,
  onCancel,
  initialText,
  quotedText,
}: {
  onSubmit: (text: string) => void;
  onCancel: () => void;
  initialText?: string;
  quotedText?: string;
}) {
  const [text, setText] = useState(initialText ?? "");

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (text.trim()) onSubmit(text.trim());
      }
    },
    [text, onSubmit],
  );

  return (
    <div className="mt-2 mb-3 ml-4 border border-(--color-border-secondary) rounded-lg bg-(--color-bg-secondary) p-3">
      {quotedText && (
        <blockquote className="mb-2 border-l-2 border-(--color-border-secondary) pl-2 text-xs text-(--color-text-secondary) italic line-clamp-3">
          {quotedText}
        </blockquote>
      )}
      <textarea
        className="w-full bg-transparent text-sm text-(--color-text-primary) outline-none resize-none min-h-[60px] placeholder:text-(--color-text-tertiary)"
        placeholder="Add a comment... (Cmd+Enter to submit, Escape to cancel)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        autoFocus
      />
      <div className="flex justify-end gap-2 mt-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => { if (text.trim()) onSubmit(text.trim()); }}
          disabled={!text.trim()}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

function CommentCard({
  comment,
  showQuote,
  onEdit,
  onDelete,
  readOnly = false,
}: {
  comment: SelectionCommentData;
  showQuote: boolean;
  onEdit: (commentId: string, text: string) => void;
  onDelete: (commentId: string) => void;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);

  const isAi = comment.source === "ai";
  const borderColor = isAi ? "border-l-purple-400" : "border-l-blue-400";
  const bgColor = isAi ? "bg-purple-950/30" : "bg-blue-950/30";

  if (editing) {
    return (
      <CommentInput
        initialText={comment.text}
        quotedText={comment.quotedText}
        onSubmit={(text) => {
          onEdit(comment.id, text);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div className={`mt-2 mb-3 ml-4 border-l-2 ${borderColor} ${bgColor} rounded-r-lg p-3 group/comment`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          {isAi && (
            <span className="text-[10px] font-semibold uppercase tracking-wider text-purple-400 mb-1 block">
              AI
            </span>
          )}
          {showQuote && comment.quotedText && (
            <blockquote className="mb-2 border-l-2 border-(--color-border-secondary) pl-2 text-xs text-(--color-text-secondary) italic line-clamp-3">
              {comment.quotedText}
            </blockquote>
          )}
          <p className="text-sm text-(--color-text-primary) whitespace-pre-wrap">{comment.text}</p>
        </div>
        {!readOnly && (
          <div className="flex gap-1 shrink-0 opacity-0 group-hover/comment:opacity-100 transition-opacity">
            <button
              onClick={() => setEditing(true)}
              className="p-1 rounded hover:bg-(--color-bg-hover) text-(--color-text-tertiary) hover:text-(--color-text-primary)"
              title="Edit"
            >
              <PencilSimpleIcon size={ICON_SIZE.SM} />
            </button>
            <button
              onClick={() => onDelete(comment.id)}
              className="p-1 rounded hover:bg-(--color-bg-hover) text-(--color-text-tertiary) hover:text-(--color-error)"
              title="Delete"
            >
              <TrashIcon size={ICON_SIZE.SM} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The user's pending selection — captured when the floating "Comment" button
 * is clicked. We snapshot the selection because the live one can be lost if
 * the user clicks elsewhere (e.g. scrolling, editing the input) before
 * submitting. The `range` is used to paint a CSS Custom Highlight while the
 * input is open, so the user keeps a visible anchor for what they're
 * commenting on.
 */
interface PendingSelection {
  quotedText: string;
  contextBefore: string;
  contextAfter: string;
  range: Range;
}

/**
 * Live snapshot of the user's current selection, captured every time the
 * selection changes. Bundles together (a) the per-line rects used to position
 * the floating Comment button, (b) the resolved selection data (quoted
 * text + context) so that clicking the button doesn't need to re-read
 * `window.getSelection()`, and (c) the underlying Range, which we promote
 * into the CSS Custom Highlight API once the comment input opens — that's
 * what keeps a visible highlight on the selected text while focus is in the
 * textarea (the native selection gets dimmed or cleared by the browser
 * depending on UA).
 *
 * `first`/`last` are the rects of the first and last line of the selection
 * (via `range.getClientRects()`). We never use `range.getBoundingClientRect()`
 * because for multi-line selections the bounding rect spans the full text
 * column — its horizontal centre lands far from the actual selected text.
 */
interface SelectionSnapshot {
  first: DOMRect;
  last: DOMRect;
  quotedText: string;
  contextBefore: string;
  contextAfter: string;
  range: Range;
}

export function MarkdownSelectionComments({
  content,
  comments,
  onAddComment,
  onEditComment,
  onDeleteComment,
  readOnly = false,
}: MarkdownSelectionCommentsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState<SelectionSnapshot | null>(null);
  const [pendingSelection, setPendingSelection] = useState<PendingSelection | null>(null);

  const fm = useMemo(() => parseFrontmatter(content), [content]);
  const blocks = useMemo(() => splitIntoTopLevelBlocks(fm.body), [fm.body]);

  // Assign each comment to the first block whose visible text contains its
  // quoted text. Anything left over goes into the orphan bucket at the bottom.
  const { commentsByBlock, orphaned } = useMemo(() => {
    const byBlock = new Map<number, SelectionCommentData[]>();
    const orphans: SelectionCommentData[] = [];
    const assigned = new Set<string>();
    for (const comment of comments) {
      let matched = false;
      for (let i = 0; i < blocks.length; i++) {
        if (assigned.has(comment.id)) break;
        if (locateInBlock(blocks[i].textContent, comment) >= 0) {
          if (!byBlock.has(i)) byBlock.set(i, []);
          byBlock.get(i)!.push(comment);
          assigned.add(comment.id);
          matched = true;
          break;
        }
      }
      if (!matched) orphans.push(comment);
    }
    return { commentsByBlock: byBlock, orphaned: orphans };
  }, [comments, blocks]);

  // Floating "Comment" button positioning. Tracks the live selection inside
  // the markdown body and surfaces a tiny button near it. The selection data
  // (quoted text + context + rects) is resolved eagerly on every change so
  // the click handler doesn't have to re-read `window.getSelection()` — see
  // the `SelectionSnapshot` doc for why that matters.
  // eslint-disable-next-line no-restricted-syntax -- selection event subscription on document
  useEffect(() => {
    if (pendingSelection) {
      setSnapshot(null);
      return;
    }
    const handler = () => {
      const sel = window.getSelection();
      const container = containerRef.current;
      if (!sel || sel.isCollapsed || !container) {
        setSnapshot(null);
        return;
      }
      if (sel.rangeCount === 0) {
        setSnapshot(null);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) {
        setSnapshot(null);
        return;
      }
      const quotedText = sel.toString();
      if (!quotedText.trim()) {
        setSnapshot(null);
        return;
      }
      const rects = Array.from(range.getClientRects()).filter(
        (r) => r.width > 0 || r.height > 0,
      );
      if (rects.length === 0) {
        setSnapshot(null);
        return;
      }
      const fullText = container.textContent ?? "";
      const startOffset = offsetWithin(container, range.startContainer, range.startOffset);
      const endOffset = startOffset + quotedText.length;
      const contextBefore =
        startOffset > 0 ? fullText.slice(Math.max(0, startOffset - CONTEXT_CHARS), startOffset) : "";
      const contextAfter =
        endOffset < fullText.length
          ? fullText.slice(endOffset, Math.min(fullText.length, endOffset + CONTEXT_CHARS))
          : "";
      setSnapshot({
        first: rects[0],
        last: rects[rects.length - 1],
        quotedText,
        contextBefore,
        contextAfter,
        range: range.cloneRange(),
      });
    };
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, [pendingSelection]);

  // Promote the latest snapshot to a pending input. We deliberately use the
  // captured snapshot rather than re-reading `window.getSelection()` — see
  // the `SelectionSnapshot` doc.
  const handleStartComment = useCallback((snap: SelectionSnapshot) => {
    setPendingSelection({
      quotedText: snap.quotedText,
      contextBefore: snap.contextBefore,
      contextAfter: snap.contextAfter,
      range: snap.range,
    });
    setSnapshot(null);
  }, []);

  // Paint a CSS Custom Highlight over the pending range while the comment
  // input is open. The native selection is dimmed/cleared by browsers once
  // focus moves to the textarea, so without this the user loses sight of
  // what they're commenting on. Falls back silently on browsers that don't
  // support the Highlight API (Chrome 105+, Safari 17.2+, Firefox 140+).
  // eslint-disable-next-line no-restricted-syntax -- not a data effect; registers a side-effecting CSS highlight
  useEffect(() => {
    if (!pendingSelection) return;
    const HighlightCtor = (
      globalThis as { Highlight?: new (...ranges: Range[]) => unknown }
    ).Highlight;
    const highlights = (
      globalThis as { CSS?: { highlights?: Map<string, unknown> } }
    ).CSS?.highlights;
    if (!HighlightCtor || !highlights) return;
    const highlight = new HighlightCtor(pendingSelection.range);
    highlights.set(HIGHLIGHT_NAME, highlight);
    return () => {
      highlights.delete(HIGHLIGHT_NAME);
    };
  }, [pendingSelection]);

  // Position the floating button against the latest selection rect. We use
  // `position: absolute` relative to `containerRef` (which is `position:
  // relative`) rather than `position: fixed`, because the markdown can be
  // rendered inside a transformed ancestor (e.g. Radix DialogContent uses
  // `-translate-x-1/2 -translate-y-1/2` to centre itself). A transformed
  // ancestor becomes the containing block for `position: fixed` descendants,
  // which silently breaks viewport-relative coordinates — the button drifts
  // toward the side of the screen. `position: absolute` relative to the
  // markdown body avoids the trap entirely and also keeps the button anchored
  // to the text when the dialog body scrolls.
  //
  // Strategy: prefer placing the button below the LAST line of the selection,
  // centred horizontally on that line. If there's no room below the viewport,
  // fall back to above the FIRST line. Horizontal position is clamped to the
  // container width so the button stays next to the selected text.
  const buttonRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const el = buttonRef.current;
    const container = containerRef.current;
    if (!el || !container || !snapshot) return;
    const containerRect = container.getBoundingClientRect();
    const margin = 6;
    const edgePad = 4;
    const bH = el.offsetHeight;
    const bW = el.offsetWidth;

    const spaceBelow = window.innerHeight - snapshot.last.bottom;
    const placeBelow = spaceBelow >= bH + margin + edgePad;
    const anchor = placeBelow ? snapshot.last : snapshot.first;
    const top = placeBelow
      ? anchor.bottom - containerRect.top + margin
      : anchor.top - containerRect.top - bH - margin;

    const desiredLeft =
      anchor.left - containerRect.left + anchor.width / 2 - bW / 2;
    const minLeft = edgePad;
    const maxLeft = Math.max(edgePad, containerRect.width - bW - edgePad);
    const left = Math.max(minLeft, Math.min(desiredLeft, maxLeft));

    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
  }, [snapshot]);

  return (
    <div className="relative" ref={containerRef}>
      {fm.hasFrontmatter && <FrontmatterHeader fm={fm} />}

      {blocks.map((block, idx) => {
        const blockComments = commentsByBlock.get(idx) ?? [];
        // Suppress the top margin on the very first block so the doc doesn't
        // start with a gap; from the second block onward, the kind-specific
        // top margin restores the section/paragraph rhythm that prose-sm
        // would have given inside a single container.
        const topMargin = idx === 0 ? "" : TOP_MARGIN_CLASS[block.topSpacing];
        return (
          <div key={idx} className={topMargin}>
            <MarkdownBlock source={block.source} />
            {blockComments.map((comment) => (
              <CommentCard
                key={comment.id}
                comment={comment}
                showQuote
                onEdit={onEditComment}
                onDelete={onDeleteComment}
                readOnly={readOnly}
              />
            ))}
          </div>
        );
      })}

      {orphaned.length > 0 && (
        <div className="mt-6 pt-4 border-t border-(--color-border-secondary)">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-(--color-text-tertiary) mb-2">
            Orphaned comments
          </h3>
          <p className="text-xs text-(--color-text-secondary) mb-3">
            These comments reference text that no longer appears in the document. They&apos;ll be sent along with the review so the agent can decide whether the feedback still applies.
          </p>
          {orphaned.map((comment) => (
            <CommentCard
              key={comment.id}
              comment={comment}
              showQuote
              onEdit={onEditComment}
              onDelete={onDeleteComment}
              readOnly={readOnly}
            />
          ))}
        </div>
      )}

      {pendingSelection && (
        <CommentInput
          quotedText={pendingSelection.quotedText}
          onSubmit={(text) => {
            onAddComment(
              pendingSelection.quotedText,
              pendingSelection.contextBefore,
              pendingSelection.contextAfter,
              text,
            );
            setPendingSelection(null);
          }}
          onCancel={() => setPendingSelection(null)}
        />
      )}

      {snapshot && !pendingSelection && !readOnly && (
        <button
          ref={buttonRef}
          onMouseDown={(e) => {
            // preventDefault stops the click from collapsing the selection or
            // moving focus to the button. stopPropagation stops Radix Dialog's
            // outside-click detection (and any other ancestor listeners) from
            // swallowing the event.
            e.preventDefault();
            e.stopPropagation();
            handleStartComment(snapshot);
          }}
          className="absolute z-50 flex items-center gap-1 px-2 py-1 rounded bg-(--color-bg-elevated) border border-(--color-border-secondary) text-xs text-(--color-text-primary) shadow-lg hover:brightness-125 hover:border-(--color-border-primary) cursor-pointer"
          title="Comment on this selection"
        >
          <ChatTeardropTextIcon size={ICON_SIZE.SM} />
          Comment
        </button>
      )}
    </div>
  );
}

