// eslint-disable-next-line no-restricted-imports -- useEffect: prune local DOM anchors when their optimistic comments leave the active review
import { useState, useMemo, useCallback, useEffect } from "react";
import { locateInBlocks } from "../utils/anchoring.js";
import type { MarkdownBlock } from "../utils/markdown.js";
import type { PendingSelection, SelectionCommentData } from "../types.js";

/**
 * Index the rendered top-level blocks, assign each comment to the block that
 * contains its selected occurrence, and expose the pending editor's block.
 *
 * Comments whose quoted text is truly missing fall into the orphan bucket.
 * Optimistic local anchors (captured from the DOM selection when a comment is
 * first added) take precedence over quote matching so duplicate text and
 * markdown/rendered-text normalization can't move a freshly added comment.
 */
export function useCommentAnchoring(
  blocks: MarkdownBlock[],
  comments: SelectionCommentData[],
  pendingSelection: PendingSelection | null,
): {
  commentsByBlock: Map<number, SelectionCommentData[]>;
  orphaned: SelectionCommentData[];
  pendingBlockIndex: number | null;
  registerLocalAnchor: (id: string, blockIndex: number) => void;
} {
  const [localAnchors, setLocalAnchors] = useState<Record<string, number>>({});

  const { indexedBlocks, renderedText } = useMemo(() => {
    let offset = 0;
    const indexed = blocks.map((block) => {
      const startOffset = offset;
      offset += block.textContent.length;
      return { ...block, startOffset, endOffset: offset };
    });
    return { indexedBlocks: indexed, renderedText: blocks.map((block) => block.textContent).join("") };
  }, [blocks]);

  // Assign each comment to the rendered top-level block containing its selected
  // occurrence. Anything whose quoted text is truly missing goes into the
  // orphan bucket at the bottom.
  const { commentsByBlock, orphaned } = useMemo(() => {
    const byBlock = new Map<number, SelectionCommentData[]>();
    const orphans: SelectionCommentData[] = [];
    for (const comment of comments) {
      const localBlockIndex = localAnchors[comment.id];
      if (
        localBlockIndex !== undefined &&
        localBlockIndex >= 0 &&
        localBlockIndex < indexedBlocks.length
      ) {
        if (!byBlock.has(localBlockIndex)) byBlock.set(localBlockIndex, []);
        byBlock.get(localBlockIndex)!.push(comment);
        continue;
      }

      const blockIndex = locateInBlocks(indexedBlocks, renderedText, comment);
      if (blockIndex >= 0) {
        if (!byBlock.has(blockIndex)) byBlock.set(blockIndex, []);
        byBlock.get(blockIndex)!.push(comment);
      } else {
        orphans.push(comment);
      }
    }
    return { commentsByBlock: byBlock, orphaned: orphans };
  }, [comments, indexedBlocks, localAnchors, renderedText]);

  // eslint-disable-next-line no-restricted-syntax -- prune local DOM anchors when their optimistic comments leave the active review
  useEffect(() => {
    setLocalAnchors((current) => {
      const commentIds = new Set(comments.map((comment) => comment.id));
      let changed = false;
      const next: Record<string, number> = {};
      for (const [id, blockIndex] of Object.entries(current)) {
        if (commentIds.has(id)) {
          next[id] = blockIndex;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [comments]);

  // Which rendered block the pending comment input should render under. This
  // comes from the DOM selection itself instead of quote matching, so duplicate
  // text and markdown/rendered-text normalization cannot move a new editor.
  const pendingBlockIndex = useMemo(() => {
    if (!pendingSelection) return null;
    return pendingSelection.blockIndex >= 0 && pendingSelection.blockIndex < indexedBlocks.length
      ? pendingSelection.blockIndex
      : null;
  }, [pendingSelection, indexedBlocks.length]);

  const registerLocalAnchor = useCallback((id: string, blockIndex: number) => {
    setLocalAnchors((current) => ({ ...current, [id]: blockIndex }));
  }, []);

  return { commentsByBlock, orphaned, pendingBlockIndex, registerLocalAnchor };
}
