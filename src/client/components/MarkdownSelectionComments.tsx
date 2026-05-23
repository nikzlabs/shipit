// eslint-disable-next-line no-restricted-imports -- useEffect: selection listener + DOM measurement, useRef: rendered body container, useLayoutEffect: position the floating button against the latest selection rect
import { useState, useMemo, useCallback, useEffect, useRef, useLayoutEffect } from "react";
import { marked } from "marked";
import { ChatTeardropTextIcon, PencilSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { Badge, type BadgeProps } from "./ui/badge.js";
import { parseFrontmatter, type ParsedFrontmatter } from "../utils/markdown-frontmatter.js";
import type { DocPriority, DocStatus } from "../../server/shared/types.js";

const CONTEXT_CHARS = 50;

export interface SelectionCommentData {
  id: string;
  quotedText: string;
  contextBefore: string;
  contextAfter: string;
  text: string;
  source?: "human" | "ai";
}

interface MarkdownBlock {
  html: string;
  textContent: string;
}

/** Render the markdown body, then split the resulting HTML into top-level blocks. */
function parseMarkdownToBlocks(content: string): MarkdownBlock[] {
  const html = marked.parse(content, { async: false });
  if (typeof document === "undefined") {
    // SSR / test fallback: return the whole document as one block.
    return [{ html, textContent: content }];
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  const blocks: MarkdownBlock[] = [];
  for (const child of Array.from(doc.body.children)) {
    blocks.push({
      html: child.outerHTML,
      textContent: child.textContent ?? "",
    });
  }
  if (blocks.length === 0 && html.trim() !== "") {
    blocks.push({ html, textContent: doc.body.textContent ?? "" });
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
}: {
  comment: SelectionCommentData;
  showQuote: boolean;
  onEdit: (commentId: string, text: string) => void;
  onDelete: (commentId: string) => void;
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
      </div>
    </div>
  );
}

/**
 * The user's pending selection — captured when the floating "Comment" button
 * is clicked. We snapshot the selection at click time because opening the
 * comment input collapses the live selection.
 */
interface PendingSelection {
  quotedText: string;
  contextBefore: string;
  contextAfter: string;
}

export function MarkdownSelectionComments({
  content,
  comments,
  onAddComment,
  onEditComment,
  onDeleteComment,
}: MarkdownSelectionCommentsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [floatingRect, setFloatingRect] = useState<DOMRect | null>(null);
  const [pendingSelection, setPendingSelection] = useState<PendingSelection | null>(null);

  const fm = useMemo(() => parseFrontmatter(content), [content]);
  const blocks = useMemo(() => parseMarkdownToBlocks(fm.body), [fm.body]);

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
  // the markdown body and surfaces a tiny button near it; clicking promotes
  // the live selection to a `pendingSelection` and shows the comment input.
  // eslint-disable-next-line no-restricted-syntax -- selection event subscription on document
  useEffect(() => {
    if (pendingSelection) {
      setFloatingRect(null);
      return;
    }
    const handler = () => {
      const sel = window.getSelection();
      const container = containerRef.current;
      if (!sel || sel.isCollapsed || !container) {
        setFloatingRect(null);
        return;
      }
      if (sel.rangeCount === 0) {
        setFloatingRect(null);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) {
        setFloatingRect(null);
        return;
      }
      const text = sel.toString();
      if (!text.trim()) {
        setFloatingRect(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setFloatingRect(null);
        return;
      }
      setFloatingRect(rect);
    };
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, [pendingSelection]);

  // Snapshot the live selection so opening the input doesn't lose it.
  const handleStartComment = useCallback(() => {
    const sel = window.getSelection();
    const container = containerRef.current;
    if (!sel || sel.isCollapsed || !container || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return;
    const quotedText = sel.toString();
    if (!quotedText.trim()) return;

    const fullText = container.textContent ?? "";
    const startOffset = offsetWithin(container, range.startContainer, range.startOffset);
    const endOffset = startOffset + quotedText.length;
    const contextBefore =
      startOffset > 0 ? fullText.slice(Math.max(0, startOffset - CONTEXT_CHARS), startOffset) : "";
    const contextAfter =
      endOffset < fullText.length
        ? fullText.slice(endOffset, Math.min(fullText.length, endOffset + CONTEXT_CHARS))
        : "";

    setPendingSelection({ quotedText, contextBefore, contextAfter });
    setFloatingRect(null);
    // Collapse the live selection so the highlight goes away while the user types.
    sel.removeAllRanges();
  }, []);

  // The floating button lives outside container scroll, so position it via fixed
  // coordinates from getBoundingClientRect. useLayoutEffect avoids a one-frame
  // flash where the button appears in the wrong place.
  const buttonRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const el = buttonRef.current;
    if (!el || !floatingRect) return;
    el.style.top = `${floatingRect.top + window.scrollY - el.offsetHeight - 6}px`;
    el.style.left = `${floatingRect.left + window.scrollX + floatingRect.width / 2 - el.offsetWidth / 2}px`;
  }, [floatingRect]);

  return (
    <div className="space-y-0 relative" ref={containerRef}>
      {fm.hasFrontmatter && <FrontmatterHeader fm={fm} />}

      {blocks.map((block, idx) => {
        const blockComments = commentsByBlock.get(idx) ?? [];
        return (
          <div key={idx}>
            <div
              className="prose dark:prose-invert prose-sm max-w-none"
              dangerouslySetInnerHTML={{ __html: block.html }}
            />
            {blockComments.map((comment) => (
              <CommentCard
                key={comment.id}
                comment={comment}
                showQuote
                onEdit={onEditComment}
                onDelete={onDeleteComment}
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

      {floatingRect && !pendingSelection && (
        <button
          ref={buttonRef}
          onMouseDown={(e) => {
            // Prevent the click from collapsing the selection before we snapshot it.
            e.preventDefault();
            handleStartComment();
          }}
          className="fixed z-50 flex items-center gap-1 px-2 py-1 rounded bg-(--color-bg-elevated) border border-(--color-border-secondary) text-xs text-(--color-text-primary) shadow-lg hover:bg-(--color-bg-hover) cursor-pointer"
          title="Comment on this selection"
        >
          <ChatTeardropTextIcon size={ICON_SIZE.SM} />
          Comment
        </button>
      )}
    </div>
  );
}

