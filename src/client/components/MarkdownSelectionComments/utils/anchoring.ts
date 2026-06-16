import type { MarkdownBlock } from "./markdown.js";
import type { SelectionCommentData } from "../types.js";

export interface IndexedMarkdownBlock extends MarkdownBlock {
  startOffset: number;
  endOffset: number;
}

export function contextMatches(
  text: string,
  idx: number,
  comment: Pick<SelectionCommentData, "quotedText" | "contextBefore" | "contextAfter">,
): boolean {
  const before = text.slice(Math.max(0, idx - comment.contextBefore.length), idx);
  const after = text.slice(
    idx + comment.quotedText.length,
    idx + comment.quotedText.length + comment.contextAfter.length,
  );
  return (
    (comment.contextBefore === "" || before.endsWith(comment.contextBefore)) &&
    (comment.contextAfter === "" || after.startsWith(comment.contextAfter))
  );
}

/**
 * Locate a selection-anchored comment inside the rendered markdown body.
 * Context is captured from the whole rendered container, so matching must also
 * happen against the whole rendered text before mapping the winning occurrence
 * back to its top-level block. This keeps duplicate quotes in later blocks from
 * being stolen by the first block's fallback match.
 */
export function locateInBlocks(
  blocks: IndexedMarkdownBlock[],
  renderedText: string,
  comment: Pick<SelectionCommentData, "quotedText" | "contextBefore" | "contextAfter">,
): number {
  if (comment.quotedText === "") return -1;
  let from = 0;
  let firstMatchBlock = -1;
  while (from <= renderedText.length) {
    const idx = renderedText.indexOf(comment.quotedText, from);
    if (idx === -1) break;
    const blockIndex = blocks.findIndex(
      (block) => idx >= block.startOffset && idx < block.endOffset,
    );
    if (firstMatchBlock === -1) firstMatchBlock = blockIndex;
    if (blockIndex >= 0 && contextMatches(renderedText, idx, comment)) {
      return blockIndex;
    }
    from = idx + 1;
  }
  return firstMatchBlock;
}

/**
 * Walk text nodes inside `root` and compute the character offset of
 * (node, offsetInNode) in the concatenated text content.
 */
export function offsetWithin(root: Node, node: Node, offsetInNode: number): number {
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
