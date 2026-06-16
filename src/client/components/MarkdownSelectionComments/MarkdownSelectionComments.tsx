import { useState, useMemo, useCallback, useRef } from "react";
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
  const [pendingSelection, setPendingSelection] = useState<PendingSelection | null>(null);

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
