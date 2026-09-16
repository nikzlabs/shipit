// eslint-disable-next-line no-restricted-imports -- useEffect: selection listener + DOM measurement, CSS Custom Highlight painting
import { useState, useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import { offsetWithin } from "../utils/anchoring.js";
import type { PendingSelection, SelectionSnapshot } from "../types.js";

const CONTEXT_CHARS = 50;
const HIGHLIGHT_NAME = "shipit-pending-comment";

function blockIndexForNode(node: Node, container: HTMLElement): number | null {
  const element = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement;
  const block = element?.closest("[data-markdown-block-index]");
  if (!block || !container.contains(block)) return null;
  const raw = block.getAttribute("data-markdown-block-index");
  if (raw === null) return null;
  const index = Number.parseInt(raw, 10);
  return Number.isFinite(index) ? index : null;
}

export function useMarkdownSelection(
  containerRef: RefObject<HTMLDivElement | null>,
  pendingSelection: PendingSelection | null,
): {
  snapshot: SelectionSnapshot | null;
  setSnapshot: Dispatch<SetStateAction<SelectionSnapshot | null>>;
} {
  const [snapshot, setSnapshot] = useState<SelectionSnapshot | null>(null);

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
      const blockIndex = blockIndexForNode(range.endContainer, container);
      if (blockIndex === null) {
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
        blockIndex,
      });
    };
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, [pendingSelection, containerRef]);

  // Keep the range visible after focus moves to the comment input.
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

  return { snapshot, setSnapshot };
}
