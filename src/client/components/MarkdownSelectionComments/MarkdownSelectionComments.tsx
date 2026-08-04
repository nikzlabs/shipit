// eslint-disable-next-line no-restricted-imports -- useEffect: mirror the transient "composing" flag out to the review store
import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { parseFrontmatter } from "../../utils/markdown-frontmatter.js";
import { FrontmatterHeader } from "./FrontmatterHeader.js";
import { MarkdownBlock } from "./MarkdownBlock.js";
import { CommentInput } from "./CommentInput.js";
import { CommentCard } from "./CommentCard.js";
import { FloatingCommentButton } from "./FloatingCommentButton.js";
import { splitIntoTopLevelBlocks, TOP_MARGIN_CLASS } from "./utils/markdown.js";
import { useMarkdownSelection } from "./hooks/useMarkdownSelection.js";
import { useCommentAnchoring } from "./hooks/useCommentAnchoring.js";
import type { PendingSelection, SelectionCommentData, SelectionSnapshot } from "./types.js";

type AddCommentResult = { id: string } | null | undefined;

export type { SelectionCommentData } from "./types.js";

export interface MarkdownSelectionCommentsProps {
  content: string;
  comments: SelectionCommentData[];
  onAddComment: (
    quotedText: string,
    contextBefore: string,
    contextAfter: string,
    text: string,
  ) => AddCommentResult | Promise<AddCommentResult>;
  onEditComment: (commentId: string, text: string) => void;
  onDeleteComment: (commentId: string) => void;
  /**
   * docs/151 — when true, hides the floating add-comment button and passes
   * no-op edit/delete callbacks so the comments render but the user can't
   * mutate them. Used by `FilePreviewModal` in agent-review snapshot mode.
   */
  readOnly?: boolean;
  /**
   * Fires whenever an unsaved comment editor opens or closes — the
   * add-comment input, or an in-place edit of an existing comment. The review
   * surface uses it to disable "Send comments" so a half-typed comment can't
   * be dropped by an accidental submit. Always fires `false` on unmount, so a
   * viewer closed mid-compose can't strand the flag.
   */
  onComposingChange?: (composing: boolean) => void;
}

export function MarkdownSelectionComments({
  content,
  comments,
  onAddComment,
  onEditComment,
  onDeleteComment,
  readOnly = false,
  onComposingChange,
}: MarkdownSelectionCommentsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pendingSelection, setPendingSelection] = useState<PendingSelection | null>(null);
  // Ids of comments currently open in their in-place edit form. A Set (rather
  // than a single id) because nothing stops the user opening two cards.
  const [editingIds, setEditingIds] = useState<ReadonlySet<string>>(() => new Set());

  const composing = pendingSelection !== null || editingIds.size > 0;

  // Keep the callback in a ref so the sync effect below depends only on
  // `composing` — a parent re-creating the handler must not re-fire it.
  const onComposingChangeRef = useRef(onComposingChange);
  onComposingChangeRef.current = onComposingChange;

  // Mirror the open-editor state out to the review surface. The cleanup is what
  // makes "close the viewer mid-compose" safe: it clears the flag on unmount as
  // well as on the transition back to idle.
  // eslint-disable-next-line no-restricted-syntax -- external sync: transient composing state → review store, with unmount cleanup
  useEffect(() => {
    onComposingChangeRef.current?.(composing);
    if (!composing) return;
    return () => onComposingChangeRef.current?.(false);
  }, [composing]);

  const handleEditingChange = useCallback((commentId: string, editing: boolean) => {
    setEditingIds((prev) => {
      if (prev.has(commentId) === editing) return prev;
      const next = new Set(prev);
      if (editing) next.add(commentId);
      else next.delete(commentId);
      return next;
    });
  }, []);

  const fm = useMemo(() => parseFrontmatter(content), [content]);
  const blocks = useMemo(() => splitIntoTopLevelBlocks(fm.body), [fm.body]);

  const { commentsByBlock, orphaned, pendingBlockIndex, registerLocalAnchor } =
    useCommentAnchoring(blocks, comments, pendingSelection);

  const { snapshot, setSnapshot } = useMarkdownSelection(containerRef, pendingSelection);

  // Promote the latest snapshot to a pending input. We deliberately use the
  // captured snapshot rather than re-reading `window.getSelection()` — see
  // the `SelectionSnapshot` doc.
  const handleStartComment = useCallback((snap: SelectionSnapshot) => {
    setPendingSelection({
      quotedText: snap.quotedText,
      contextBefore: snap.contextBefore,
      contextAfter: snap.contextAfter,
      range: snap.range,
      blockIndex: snap.blockIndex,
    });
    setSnapshot(null);
  }, [setSnapshot]);

  const pendingInput = pendingSelection ? (
    <CommentInput
      quotedText={pendingSelection.quotedText}
      onSubmit={(text) => {
        const blockIndex = pendingSelection.blockIndex;
        const result = onAddComment(
          pendingSelection.quotedText,
          pendingSelection.contextBefore,
          pendingSelection.contextAfter,
          text,
        );
        void (async () => {
          const comment = await result;
          if (comment?.id) {
            registerLocalAnchor(comment.id, blockIndex);
          }
        })();
        setPendingSelection(null);
      }}
      onCancel={() => setPendingSelection(null)}
    />
  ) : null;

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
          <div key={idx} className={topMargin} data-markdown-block-index={idx}>
            <MarkdownBlock source={block.source} />
            {blockComments.map((comment) => (
              <CommentCard
                key={comment.id}
                comment={comment}
                showQuote
                onEdit={onEditComment}
                onDelete={onDeleteComment}
                onEditingChange={handleEditingChange}
                readOnly={readOnly}
              />
            ))}
            {pendingBlockIndex === idx && pendingInput}
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
              onEditingChange={handleEditingChange}
              readOnly={readOnly}
            />
          ))}
        </div>
      )}

      {snapshot && !pendingSelection && !readOnly && (
        <FloatingCommentButton
          snapshot={snapshot}
          containerRef={containerRef}
          onStart={() => handleStartComment(snapshot)}
        />
      )}
    </div>
  );
}
