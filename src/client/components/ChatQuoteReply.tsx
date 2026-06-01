// eslint-disable-next-line no-restricted-imports -- useEffect: document selectionchange listener, useLayoutEffect: position the floating button against the live selection rect
import { useState, useRef, useCallback, useEffect, useLayoutEffect } from "react";
import type { RefObject } from "react";
import { QuotesIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { useSessionStore } from "../stores/session-store.js";
import { formatBlockquote } from "../utils/format-blockquote.js";

/**
 * SHI-10 — floating "Reply" button shown when the user highlights text inside a
 * chat message bubble. Clicking it appends the selected passage as a markdown
 * blockquote into the chat composer (via `session-store.quoteReplyText`, which
 * MessageInput consumes), so the user can quote-reply to a specific passage
 * from the agent.
 *
 * Scope: the button only appears for selections whose range is contained within
 * `containerRef` — the conversation/message-list scroll container. The composer
 * (a sibling of the message list) and every other panel are outside that
 * container, so a selection there never surfaces the button. This mirrors the
 * containment check `MarkdownSelectionComments` uses to keep its own popover
 * scoped to the rendered doc body.
 *
 * We deliberately keep this separate from `MarkdownSelectionComments`: that
 * component anchors persistent review comments to a doc and lives inside the
 * file-preview modal; this one is a transient, fire-and-forget quote action for
 * live chat. The shared mechanics (selectionchange listener + positioning a
 * floating button near the selection rect) are reimplemented here rather than
 * abstracted, because the two surfaces have different lifecycles and the shared
 * surface area would be a thin, leaky base.
 */

/** Live snapshot of the selection used to position the floating button. */
interface QuoteSnapshot {
  /** Bounding rect of the selection, in viewport coordinates (for `position: fixed`). */
  rect: DOMRect;
  /** The selected text, resolved eagerly so the click handler needn't re-read the selection. */
  text: string;
}

export function ChatQuoteReply({
  containerRef,
}: {
  containerRef: RefObject<HTMLElement | null>;
}) {
  const [snapshot, setSnapshot] = useState<QuoteSnapshot | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Track the live selection inside the message list and surface a small
  // "Reply" button near it. The selected text is captured on every change so
  // the click handler doesn't have to re-read `window.getSelection()` (which
  // can be collapsed or lost by the time the button is pressed).
  // eslint-disable-next-line no-restricted-syntax -- selection event subscription on document
  useEffect(() => {
    const handler = () => {
      const container = containerRef.current;
      const sel = typeof window !== "undefined" ? window.getSelection() : null;
      if (!container || !sel || sel.isCollapsed || sel.rangeCount === 0) {
        setSnapshot(null);
        return;
      }
      const range = sel.getRangeAt(0);
      // Only fire for selections wholly inside the conversation container —
      // not the composer, not other panels.
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
    };
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, [containerRef]);

  // Position the button (fixed, viewport-relative) above the selection,
  // centred horizontally, clamped to the viewport. Falls back to below the
  // selection when there isn't room above. Runs in a layout effect so we can
  // measure the button's own size before placing it.
  useLayoutEffect(() => {
    const el = buttonRef.current;
    if (!el || !snapshot) return;
    const margin = 6;
    const pad = 4;
    const bW = el.offsetWidth;
    const bH = el.offsetHeight;
    const { rect } = snapshot;

    const placeAbove = rect.top >= bH + margin + pad;
    const top = placeAbove ? rect.top - bH - margin : rect.bottom + margin;

    const viewportW = typeof window !== "undefined" ? window.innerWidth : 0;
    const desiredLeft = rect.left + rect.width / 2 - bW / 2;
    const maxLeft = Math.max(pad, viewportW - bW - pad);
    const left = Math.max(pad, Math.min(desiredLeft, maxLeft));

    el.style.top = `${Math.max(pad, top)}px`;
    el.style.left = `${left}px`;
  }, [snapshot]);

  const handleReply = useCallback(() => {
    if (!snapshot) return;
    const blockquote = formatBlockquote(snapshot.text);
    if (!blockquote) {
      setSnapshot(null);
      return;
    }
    useSessionStore.getState().setQuoteReplyText(blockquote);
    // Clear the native selection so the button disappears and the user's focus
    // moves cleanly to the composer (which MessageInput focuses on consume).
    window.getSelection()?.removeAllRanges();
    setSnapshot(null);
  }, [snapshot]);

  if (!snapshot) return null;

  return (
    <button
      ref={buttonRef}
      // mousedown rather than click: preventDefault stops the press from
      // collapsing the selection before our handler reads it, and we still run
      // the action synchronously on press.
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        handleReply();
      }}
      className="fixed z-50 flex items-center gap-1 px-2 py-1 rounded-md bg-(--color-bg-elevated) border border-(--color-border-secondary) text-xs text-(--color-text-primary) shadow-lg hover:brightness-125 hover:border-(--color-border-primary) cursor-pointer"
      title="Quote this passage in your reply"
      data-testid="chat-quote-reply"
    >
      <QuotesIcon size={ICON_SIZE.SM} weight="fill" />
      Reply
    </button>
  );
}
