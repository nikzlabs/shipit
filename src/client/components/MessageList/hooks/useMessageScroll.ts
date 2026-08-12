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
function scheduleScrollToBottom(
  container: HTMLElement,
  shouldContinue: () => boolean,
  onSettled: () => void,
): () => void {
  let cancelled = false;
  let lastHeight = -1;
  let stableFrames = 0;
  const start = now();

  const stop = () => {
    if (cancelled) return;
    cancelled = true;
    onSettled();
  };

  const tick = () => {
    if (cancelled) return;
    if (!shouldContinue()) {
      stop();
      return;
    }
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
    } else {
      // Settled: report it so the caller stops treating scroll events as ours.
      stop();
    }
  };

  window.requestAnimationFrame(tick);

  return stop;
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
  // Canceller for the in-flight post-send settle loop, so a manual scroll can
  // halt it the instant the user takes control (see the gesture listeners below).
  const cancelSettleRef = useRef<(() => void) | null>(null);
  // True while that loop is re-pinning the view, i.e. while every scroll event
  // the container fires is one we caused (see `handleScroll`).
  const settlingRef = useRef(false);

  // Track whether the user has scrolled away from the bottom, and let any manual
  // scroll take authoritative control — we must never fight a user's scroll.
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      // While the settle loop is running, every scroll event is our own doing: a
      // programmatic pin fires one too, and it is delivered a frame later — by
      // which time a `content-visibility: auto` child may have painted its real
      // height, so the event reports a position far above the *new* bottom
      // although nobody touched the scrollbar. Reading that as "the user scrolled
      // away" cancelled the loop mid-message and stranded the view partway: the
      // exact stranding the loop exists to correct, and worse the taller the
      // message or card that just painted. Comparing the offset against the one
      // we pinned is not a way out — scroll anchoring shifts the position between
      // the write and the event, so our own echo does not report the offset we
      // wrote. A real user scroll always comes with a gesture, and those (below)
      // stop the loop first, which reopens this handler.
      if (settlingRef.current) return;

      const near = isNearBottom(container);
      autoScrollRef.current = near;
      // Moving away from the bottom (scrollbar drag, keyboard, momentum) cancels
      // any forced scroll immediately.
      if (!near) cancelSettleRef.current?.();
    };

    // These fire only from genuine user input — never from a programmatic
    // `scrollTop` write — so they are an unambiguous "user took control" signal,
    // and they cover every way a person can scroll this container: `wheel`
    // (mouse, trackpad, momentum), `touchmove` (touch), `pointerdown` (grabbing
    // the scrollbar), `keydown` (Page Down, arrows, Home/End, with focus inside
    // the transcript; the composer is outside this container, so typing there
    // does not reach us). Halt the in-flight settle loop on the very first
    // gesture, even before it crosses the near-bottom threshold, so a manual
    // scroll is never overridden — and so `handleScroll` starts honouring the
    // events the gesture itself produces.
    const handleManualScroll = () => {
      cancelSettleRef.current?.();
    };
    const MANUAL_SCROLL_EVENTS = ["wheel", "touchmove", "pointerdown", "keydown"] as const;

    handleScroll();
    container.addEventListener("scroll", handleScroll, { passive: true });
    for (const type of MANUAL_SCROLL_EVENTS) {
      container.addEventListener(type, handleManualScroll, { passive: true });
    }

    const observer = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          if (autoScrollRef.current) scrollToBottom(container);
        })
      : null;
    observer?.observe(container);

    return () => {
      container.removeEventListener("scroll", handleScroll);
      for (const type of MANUAL_SCROLL_EVENTS) {
        container.removeEventListener(type, handleManualScroll);
      }
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

    settlingRef.current = true;
    const cancel = scheduleScrollToBottom(
      container,
      () => {
        const latestContainer = containerRef.current;
        return latestContainer === container && autoScrollRef.current;
      },
      () => {
        settlingRef.current = false;
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
      // Jumping to a match is the user deliberately leaving the bottom, and it is
      // the one scroll here that moves the view without a gesture — so say so
      // outright rather than leaving `handleScroll` to infer it, which it cannot
      // do while the settle loop owns the scroll events.
      cancelSettleRef.current?.();
      autoScrollRef.current = false;
      currentMatchRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [currentMatch]);

  return { containerRef, currentMatchRef };
}
