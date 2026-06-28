// eslint-disable-next-line no-restricted-imports -- useEffect/useLayoutEffect: DOM scroll sync, window keydown listener, xterm auto-scroll
import { useEffect, useLayoutEffect, useRef } from "react";
import type { SearchMatch } from "../../../hooks/useSearch.js";
import type { ChatMessage } from "../types.js";

// The user counts as "following" the conversation while within this many px of
// the bottom; scrolling further up suspends auto-follow.
const BOTTOM_THRESHOLD_PX = 40;
// Auto-follow only *resumes* once the user is essentially pinned to the true
// bottom — tighter than BOTTOM_THRESHOLD_PX so a manual pause is sticky (a small
// scroll up doesn't immediately re-arm following) but a no-op scroll at the
// bottom never gets stuck off.
const AT_BOTTOM_PX = 4;
// Keep re-pinning to the bottom until the content height has been stable for
// this many consecutive frames (layout settled)...
const STABLE_FRAMES = 3;
// ...but always run at least this many frames first, so the content-visibility
// placeholder height (constant for the first frame or two) can't be mistaken for
// a settled layout and end the loop before the real height paints in.
const MIN_SETTLE_FRAMES = 8;
const MAX_SCROLL_SETTLE_MS = 1000;

function bottomGap(container: HTMLElement): number {
  const { scrollTop, scrollHeight, clientHeight } = container;
  return scrollHeight - scrollTop - clientHeight;
}

function isNearBottom(container: HTMLElement): boolean {
  return bottomGap(container) < BOTTOM_THRESHOLD_PX;
}

function isAtBottom(container: HTMLElement): boolean {
  return bottomGap(container) <= AT_BOTTOM_PX;
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
 * keep correcting until `scrollHeight` has been unchanged for a few frames AND a
 * minimum window has elapsed (so the placeholder height isn't mistaken for a
 * settled layout), bounded by a safety cap so streaming never loops forever.
 * `onSettled` fires when the loop ends on its own (not via the returned cancel).
 */
function scheduleScrollToBottom(
  container: HTMLElement,
  shouldContinue: () => boolean,
  onSettled?: () => void,
): () => void {
  let cancelled = false;
  let lastHeight = -1;
  let stableFrames = 0;
  let frames = 0;
  const start = now();

  const stop = () => {
    if (cancelled) return;
    cancelled = true;
    onSettled?.();
  };

  const tick = () => {
    if (cancelled) return;
    if (!shouldContinue()) {
      stop();
      return;
    }
    scrollToBottom(container);
    frames += 1;

    const height = container.scrollHeight;
    if (height === lastHeight) {
      stableFrames += 1;
    } else {
      stableFrames = 0;
      lastHeight = height;
    }

    const settled = stableFrames >= STABLE_FRAMES && frames >= MIN_SETTLE_FRAMES;
    if (settled || now() - start >= MAX_SCROLL_SETTLE_MS) {
      stop();
      return;
    }
    window.requestAnimationFrame(tick);
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
  // True once the user has manually scrolled away from the bottom. Sticky: it
  // suppresses ALL auto-scroll (settle loop, ResizeObserver, streaming re-pin)
  // until the user scrolls back to the true bottom or sends a new message, so we
  // never override a manual scroll. Cleared in `handleScroll` / the layout effect.
  const manualPausedRef = useRef(false);
  const previousMessageCountRef = useRef(0);
  const currentMatchRef = useRef<HTMLElement | null>(null);
  // Canceller for the in-flight post-send settle loop, so a manual scroll can
  // halt it the instant the user takes control (see the gesture listeners below).
  const cancelSettleRef = useRef<(() => void) | null>(null);

  // Track whether the user has scrolled away from the bottom, and let any manual
  // scroll take authoritative control — we must never fight a user's scroll.
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // While paused, every scroll event is user-driven (we never scroll
    // programmatically when paused), so the only thing that re-arms auto-follow
    // is the user returning to the true bottom. Otherwise, leaving the near-bottom
    // band is itself a manual scroll-away: pause and stop any forced scroll.
    const handleScroll = () => {
      if (manualPausedRef.current) {
        if (isAtBottom(container)) {
          manualPausedRef.current = false;
          autoScrollRef.current = true;
        }
        return;
      }
      if (!isNearBottom(container)) {
        pauseAutoScroll();
      }
    };

    const pauseAutoScroll = () => {
      manualPausedRef.current = true;
      autoScrollRef.current = false;
      cancelSettleRef.current?.();
    };

    // `wheel`/`touchmove` fire only from genuine user input — never from a
    // programmatic `scrollTop` write — so an upward gesture is an unambiguous
    // "user took control" signal. Pause immediately, even from the exact bottom
    // and before the scroll crosses the near-bottom threshold, so streaming
    // re-pins can't keep yanking the user back down. A downward gesture is the
    // user heading toward the bottom, so it must NOT pause (and a no-op wheel at
    // the bottom must never get stuck off-follow).
    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) pauseAutoScroll();
    };

    let lastTouchY = 0;
    const handleTouchStart = (e: TouchEvent) => {
      lastTouchY = e.touches[0]?.clientY ?? 0;
    };
    const handleTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? lastTouchY;
      // Finger moving down reveals older messages (content scrolls up) = the user
      // is scrolling back through history → take control.
      if (y > lastTouchY) pauseAutoScroll();
      lastTouchY = y;
    };

    handleScroll();
    container.addEventListener("scroll", handleScroll, { passive: true });
    container.addEventListener("wheel", handleWheel, { passive: true });
    container.addEventListener("touchstart", handleTouchStart, { passive: true });
    container.addEventListener("touchmove", handleTouchMove, { passive: true });

    const observer = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          if (autoScrollRef.current && !manualPausedRef.current) scrollToBottom(container);
        })
      : null;
    observer?.observe(container);

    return () => {
      container.removeEventListener("scroll", handleScroll);
      container.removeEventListener("wheel", handleWheel);
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
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

    // Sending a message is a deliberate action that re-anchors the conversation,
    // clearing any manual scroll pause.
    if (appendedUserMessage) manualPausedRef.current = false;

    if (!autoScrollRef.current && !appendedUserMessage) return;
    if (manualPausedRef.current) return;
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

    let cancel: () => void = () => {};
    cancel = scheduleScrollToBottom(
      container,
      () => {
        const latestContainer = containerRef.current;
        return latestContainer === container && autoScrollRef.current && !manualPausedRef.current;
      },
      () => {
        if (cancelSettleRef.current === cancel) cancelSettleRef.current = null;
      },
    );
    cancelSettleRef.current = cancel;
    return () => {
      cancel();
      if (cancelSettleRef.current === cancel) cancelSettleRef.current = null;
    };
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
