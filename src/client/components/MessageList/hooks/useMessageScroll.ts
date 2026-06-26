// eslint-disable-next-line no-restricted-imports -- useEffect/useLayoutEffect: DOM scroll sync, window keydown listener, xterm auto-scroll
import { useEffect, useLayoutEffect, useRef } from "react";
import type { SearchMatch } from "../../../hooks/useSearch.js";
import type { ChatMessage } from "../types.js";

const BOTTOM_THRESHOLD_PX = 40;
// Keep re-pinning to the bottom until the content height has been stable for
// this many consecutive frames (layout settled), or until the safety cap.
const STABLE_FRAMES = 3;
const MAX_SCROLL_SETTLE_MS = 1000;

function isNearBottom(container: HTMLElement): boolean {
  const { scrollTop, scrollHeight, clientHeight } = container;
  return scrollHeight - scrollTop - clientHeight < BOTTOM_THRESHOLD_PX;
}

function scrollToBottom(container: HTMLElement): void {
  container.scrollTop = container.scrollHeight;
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : 0;
}

/**
 * Re-pin the container to the bottom across multiple frames until the content
 * height settles. A tall, freshly-appended message renders with
 * `content-visibility: auto` (see MessageList), so it first reports a small
 * placeholder height and grows as it actually paints. A fixed frame budget can
 * stop before the real bottom — leaving the view stranded mid-message — so we
 * keep correcting until `scrollHeight` has been unchanged for a few frames
 * (bounded by a safety cap so streaming never loops forever).
 */
function scheduleScrollToBottom(container: HTMLElement, shouldContinue: () => boolean): () => void {
  let cancelled = false;
  let lastHeight = -1;
  let stableFrames = 0;
  const start = now();

  const tick = () => {
    if (cancelled || !shouldContinue()) return;
    scrollToBottom(container);

    const height = container.scrollHeight;
    if (height === lastHeight) {
      stableFrames += 1;
    } else {
      stableFrames = 0;
      lastHeight = height;
    }

    if (stableFrames < STABLE_FRAMES && now() - start < MAX_SCROLL_SETTLE_MS) {
      window.requestAnimationFrame(tick);
    }
  };

  window.requestAnimationFrame(tick);

  return () => {
    cancelled = true;
  };
}

/**
 * Scroll behavior for the message transcript: keep the conversation pinned to
 * the bottom while the user is near it, anchor on a newly-appended user message,
 * and scroll the current search match into view. Returns the container ref (for
 * the scroll element) and the current-match ref (handed to `HighlightedText` so
 * the active match can be scrolled to).
 */
export function useMessageScroll(
  messages: ChatMessage[],
  isLoading: boolean,
  currentMatch: SearchMatch | undefined,
): {
  containerRef: React.RefObject<HTMLDivElement | null>;
  currentMatchRef: React.RefObject<HTMLElement | null>;
} {
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const previousMessageCountRef = useRef(0);
  const currentMatchRef = useRef<HTMLElement | null>(null);

  // Track whether the user has scrolled away from the bottom
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      autoScrollRef.current = isNearBottom(container);
    };

    handleScroll();
    container.addEventListener("scroll", handleScroll);

    const observer = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          if (autoScrollRef.current) scrollToBottom(container);
        })
      : null;
    observer?.observe(container);

    return () => {
      container.removeEventListener("scroll", handleScroll);
      observer?.disconnect();
    };
  }, []);

  // Auto-scroll to bottom only if user hasn't scrolled up.
  // A newly appended user message is an explicit send action, so it anchors the
  // conversation even if layout/keyboard/input-height changes briefly made the
  // old bottom look stale.
  // Skip while the user has an active selection inside the message list —
  // otherwise streaming tokens trigger scrollIntoView on every render and
  // continuously cancel the in-progress text selection.
  useLayoutEffect(() => {
    const previousMessageCount = previousMessageCountRef.current;
    previousMessageCountRef.current = messages.length;
    const latestMessage = messages[messages.length - 1];
    const appendedUserMessage = messages.length > previousMessageCount && latestMessage?.role === "user";

    if (!autoScrollRef.current && !appendedUserMessage) return;
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (
      sel &&
      !sel.isCollapsed &&
      containerRef.current &&
      sel.anchorNode &&
      containerRef.current.contains(sel.anchorNode)
    ) {
      return;
    }
    const container = containerRef.current;
    if (!container) return;

    scrollToBottom(container);
    autoScrollRef.current = true;

    return scheduleScrollToBottom(container, () => {
      const latestContainer = containerRef.current;
      return latestContainer === container && autoScrollRef.current;
    });
  }, [messages, isLoading]);

  // Scroll to the current search match when it changes
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (currentMatch && currentMatchRef.current) {
      currentMatchRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [currentMatch]);

  return { containerRef, currentMatchRef };
}
