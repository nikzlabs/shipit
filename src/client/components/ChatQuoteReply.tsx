import { useState, useRef, useCallback, useLayoutEffect } from "react";
import { useEventListener } from "../hooks/useEventListener.js";
import { useIsMobile } from "../hooks/useMediaQuery.js";
import type { RefObject } from "react";
import { QuotesIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { useSessionStore } from "../stores/session-store.js";
import { formatBlockquote } from "../utils/format-blockquote.js";

interface QuoteSnapshot {
  rect: DOMRect;
  text: string;
}

export function ChatQuoteReply({
  containerRef,
}: {
  containerRef: RefObject<HTMLElement | null>;
}) {
  const [snapshot, setSnapshot] = useState<QuoteSnapshot | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const isMobile = useIsMobile();

  useEventListener(document, "selectionchange", () => {
    const container = containerRef.current;
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (!container || !sel || sel.isCollapsed || sel.rangeCount === 0) {
      setSnapshot(null);
      return;
    }
    const range = sel.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) {
      setSnapshot(null);
      return;
    }
    const text = sel.toString();
    if (!text.trim()) {
      setSnapshot(null);
      return;
    }
    setSnapshot({ rect: range.getBoundingClientRect(), text });
  });

  useLayoutEffect(() => {
    const el = buttonRef.current;
    if (!el || !snapshot) return;
    const margin = 6;
    const pad = 4;
    const bW = el.offsetWidth;
    const bH = el.offsetHeight;
    const { rect } = snapshot;

    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    const viewportW = vv?.width ?? (typeof window !== "undefined" ? window.innerWidth : 0);
    const viewportH = vv?.height ?? (typeof window !== "undefined" ? window.innerHeight : 0);
    const viewportTop = vv?.offsetTop ?? 0;
    const viewportLeft = vv?.offsetLeft ?? 0;

    // Mobile selection menus usually occupy the space above the selection.
    const placeAbove = !isMobile && rect.top >= bH + margin + pad;
    const desiredTop = placeAbove ? rect.top - bH - margin : rect.bottom + margin;
    const minTop = viewportTop + pad;
    const maxTop = Math.max(minTop, viewportTop + viewportH - bH - pad);
    const top = Math.min(Math.max(desiredTop, minTop), maxTop);

    const desiredLeft = rect.left + rect.width / 2 - bW / 2;
    const minLeft = viewportLeft + pad;
    const maxLeft = Math.max(minLeft, viewportLeft + viewportW - bW - pad);
    const left = Math.min(Math.max(desiredLeft, minLeft), maxLeft);

    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
  }, [snapshot, isMobile]);

  const handleReply = useCallback(() => {
    if (!snapshot) return;
    const blockquote = formatBlockquote(snapshot.text);
    if (!blockquote) {
      setSnapshot(null);
      return;
    }
    useSessionStore.getState().setQuoteReplyText(blockquote);
    window.getSelection()?.removeAllRanges();
    setSnapshot(null);
  }, [snapshot]);

  if (!snapshot) return null;

  return (
    <button
      ref={buttonRef}
      // Prevent the press from clearing the selection before replying.
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        handleReply();
      }}
      className={`fixed z-50 flex items-center gap-1 rounded-md bg-(--color-bg-elevated) border border-(--color-border-secondary) text-(--color-text-primary) shadow-lg hover:brightness-125 hover:border-(--color-border-primary) cursor-pointer ${
        isMobile ? "px-3 py-2 text-sm" : "px-2 py-1 text-xs"
      }`}
      title="Quote this passage in your reply"
      data-testid="chat-quote-reply"
    >
      <QuotesIcon size={ICON_SIZE.SM} weight="fill" />
      Reply
    </button>
  );
}
