// eslint-disable-next-line no-restricted-imports -- useEffect/useLayoutEffect: DOM scroll sync, window keydown listener, xterm auto-scroll
import { useEffect, useLayoutEffect, useRef } from "react";
import type { SearchMatch } from "../../../hooks/useSearch.js";
import type { ChatMessage } from "../types.js";

const BOTTOM_THRESHOLD_PX = 40;
// Keep re-pinning to the bottom until the content height has been stable for
// this many consecutive frames (layout settled), or until the safety cap.
const STABLE_FRAMES = 3;
const MAX_SCROLL_SETTLE_MS = 1000;
// How long after the last gesture event we keep standing down. A touch drag ends
// with the finger lifting, but the scroll does not — momentum carries on with no
// further `touchmove`, and writing `scrollTop` during it kills the momentum dead.
const GESTURE_GRACE_MS = 400;

function isNearBottom(container: HTMLElement): boolean {
  const { scrollTop, scrollHeight, clientHeight } = container;
  return scrollHeight - scrollTop - clientHeight < BOTTOM_THRESHOLD_PX;
}

function scrollToBottom(container: HTMLElement): void {
  container.scrollTop = container.scrollHeight;
}

/**
 * Is the user selecting text inside the transcript? Scrolling while they drag
 * moves the content out from under the pointer and wrecks the selection, so
 * EVERY auto-scroll path has to stand down until it is gone — the streaming
 * re-pin and the content observer alike, since during streaming both fire on
 * roughly every token.
 */
function hasActiveSelectionInside(container: HTMLElement | null): boolean {
  if (!container || typeof window === "undefined") return false;
  const selection = window.getSelection();
  return Boolean(
    selection && !selection.isCollapsed && selection.anchorNode && container.contains(selection.anchorNode),
  );
}

// `Date.now()` rather than a constant fallback: a frozen clock would make the
// settle loop's safety cap unreachable and leave every gesture grace window
// permanently open.
function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Has the user got hold of the scroll right now?
 *
 * `autoScrollRef` cannot answer this. It only flips once the user crosses
 * BOTTOM_THRESHOLD_PX, and a SLOW drag — a thumb walking back through the
 * transcript on a phone — stays inside that band for many frames. Every
 * auto-scroll path fires during those frames, so a slow scroll got dragged back
 * to the bottom while a fast flick, which leaves the band within a single frame,
 * did not. A live gesture is authoritative over all of them — "we must never
 * fight a user's scroll" has to hold before the threshold is crossed, not only
 * after.
 *
 * Mobile makes that band wider than it looks, which is why the threshold cannot
 * be the whole answer. The address bar collapses as the user scrolls, and that
 * GROWS the container's `clientHeight` — so `scrollHeight - scrollTop -
 * clientHeight` shrinks with no scrolling and no content growth at all. A user
 * who had deliberately moved 60px clear of the bottom lands back inside the
 * threshold, re-arming auto-follow at a position they chose. The same resize
 * reaches the observer, which cannot tell it apart from the transcript growing.
 * Widening BOTTOM_THRESHOLD_PX would not have helped: the address bar moves the
 * boundary by its own height, whatever we set it to.
 *
 * Takes refs rather than closing over them so it can sit at module scope, out of
 * the `[]`-dependency effect's reach.
 */
function userIsDriving(dragging: { current: boolean }, lastGestureAt: { current: number }): boolean {
  return dragging.current || now() - lastGestureAt.current < GESTURE_GRACE_MS;
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
 * and scroll the current search match into view. Returns the container ref (the
 * scroll element), the content ref (the element wrapping the messages, whose
 * height is watched) and the current-match ref (handed to `HighlightedText` so
 * the active match can be scrolled to).
 */
export function useMessageScroll(
  messages: ChatMessage[],
  isLoading: boolean,
  currentMatch: SearchMatch | undefined,
): {
  containerRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  currentMatchRef: React.RefObject<HTMLElement | null>;
} {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const previousMessageCountRef = useRef(0);
  const currentMatchRef = useRef<HTMLElement | null>(null);
  // Canceller for the in-flight post-send settle loop, so a manual scroll can
  // halt it the instant the user takes control (see the gesture listeners below).
  const cancelSettleRef = useRef<(() => void) | null>(null);
  // Is a finger currently dragging the transcript, and when did the last gesture
  // event land? `-Infinity` so a freshly-mounted hook is never inside the grace
  // window. See `userIsDriving` for why this gates every auto-scroll path.
  const touchDraggingRef = useRef(false);
  const lastGestureAtRef = useRef(-Infinity);

  // Track whether the user has scrolled away from the bottom, and let any manual
  // scroll take authoritative control — we must never fight a user's scroll.
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const near = isNearBottom(container);
      autoScrollRef.current = near;
      // Moving away from the bottom (scrollbar drag, keyboard, momentum) cancels
      // any forced scroll immediately.
      if (!near) cancelSettleRef.current?.();
    };

    // `wheel`/`touchmove` fire only from genuine user input — never from a
    // programmatic `scrollTop` write — so they are an unambiguous "user took
    // control" signal. Halt the in-flight settle loop on the very first gesture,
    // even before it crosses the near-bottom threshold, so a manual scroll is
    // never overridden, and stamp the gesture so the OTHER two auto-scroll paths
    // (the layout effect's re-pin, the observer's) stand down for its duration.
    const handleManualScroll = () => {
      lastGestureAtRef.current = now();
      cancelSettleRef.current?.();
    };

    // `wheel` deliberately gets the timestamp and NOT the drag flag below: it has
    // no end event, so a sticky flag set here would never clear and would suppress
    // auto-follow for the rest of the session. A trackpad emits `wheel` densely
    // enough through a gesture to keep refreshing the stamp; a discrete mouse
    // notch is a scroll that genuinely finished, so re-arming after it is right.
    //
    // The drag flag comes from `touchmove`, not `touchstart`: a bare tap on the
    // transcript scrolls nothing, and letting it suppress auto-follow would strand
    // a streaming message for the whole grace window over a stray thumb.
    const handleTouchMove = () => {
      touchDraggingRef.current = true;
      handleManualScroll();
    };
    // The finger lifting does not end the scroll — momentum runs on with no
    // further `touchmove` — so clearing the flag hands over to the timestamp
    // grace rather than resuming auto-follow immediately.
    const handleTouchEnd = () => {
      touchDraggingRef.current = false;
      lastGestureAtRef.current = now();
    };

    handleScroll();
    container.addEventListener("scroll", handleScroll, { passive: true });
    container.addEventListener("wheel", handleManualScroll, { passive: true });
    container.addEventListener("touchmove", handleTouchMove, { passive: true });
    container.addEventListener("touchend", handleTouchEnd, { passive: true });
    container.addEventListener("touchcancel", handleTouchEnd, { passive: true });

    // Two things move the bottom out from under us, and neither fires a scroll
    // event: the container getting shorter (the composer growing), and the
    // transcript getting taller. The second is the one that stranded the view —
    // a message renders as an 80px `content-visibility` placeholder and grows
    // when it paints, which the container's own box never reflects, so watching
    // only the container missed it. Watching the content element catches every
    // height change whenever it lands, including a card that expands long after
    // the settle loop has given up. It also lands in the same rendering update
    // as the growth, i.e. BEFORE the scroll event that growth would otherwise
    // produce, so `handleScroll` never sees a position stranded by our own pin
    // and never mistakes it for the user scrolling away.
    //
    // It stands down mid-gesture, though: on mobile the address bar collapses as
    // the user scrolls, which resizes the container and lands here as a resize
    // indistinguishable from the transcript growing.
    const observer = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          if (userIsDriving(touchDraggingRef, lastGestureAtRef)) return;
          if (autoScrollRef.current && !hasActiveSelectionInside(container)) scrollToBottom(container);
        })
      : null;
    observer?.observe(container);
    if (contentRef.current) observer?.observe(contentRef.current);

    return () => {
      container.removeEventListener("scroll", handleScroll);
      container.removeEventListener("wheel", handleManualScroll);
      container.removeEventListener("touchmove", handleTouchMove);
      container.removeEventListener("touchend", handleTouchEnd);
      container.removeEventListener("touchcancel", handleTouchEnd);
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
    // A live gesture outranks auto-follow — but NOT an explicit send, which is
    // newer user intent than the drag and re-anchors the conversation. Sending
    // also ends the gesture: the tap landed on the composer, not the transcript.
    if (appendedUserMessage) {
      touchDraggingRef.current = false;
      lastGestureAtRef.current = -Infinity;
    } else if (userIsDriving(touchDraggingRef, lastGestureAtRef)) {
      return;
    }
    if (hasActiveSelectionInside(containerRef.current)) return;
    const container = containerRef.current;
    if (!container) return;

    scrollToBottom(container);
    autoScrollRef.current = true;

    const cancel = scheduleScrollToBottom(container, () => {
      const latestContainer = containerRef.current;
      if (userIsDriving(touchDraggingRef, lastGestureAtRef)) return false;
      return latestContainer === container && autoScrollRef.current;
    });
    cancelSettleRef.current = cancel;
    return () => {
      cancel();
      if (cancelSettleRef.current === cancel) cancelSettleRef.current = null;
    };
  }, [messages, isLoading]);

  // Scroll to the current search match when it changes, then keep re-centring it
  // until the transcript's height settles.
  //
  // planning#491 — the re-centring is not belt-and-braces. `content-visibility:
  // auto` sits on GROUPS of 20 rows, and a group that has never been on screen
  // has only an ESTIMATED height (`contain-intrinsic-size`). Jumping to a match
  // inside such a group renders it for real, and the real height replaces the
  // estimate in the same frame — moving the match out from under the scroll that
  // just landed on it, by however wrong the estimate was for those 20 rows. One
  // `scrollIntoView` therefore lands next to the match rather than on it.
  //
  // Bottom-pinning never had this problem because its ResizeObserver corrects
  // continuously; this path had no correction at all. The loop is the same shape
  // as `scheduleScrollToBottom`: re-centre whenever the height changed, stop
  // once it has held for a few frames, and stand down the moment the user takes
  // hold of the scroll.
  // eslint-disable-next-line no-restricted-syntax -- scroll settle loop with cleanup
  useEffect(() => {
    if (!currentMatch || !currentMatchRef.current) return;
    currentMatchRef.current.scrollIntoView({ behavior: "smooth", block: "center" });

    let cancelled = false;
    let lastHeight = -1;
    let stableFrames = 0;
    const start = now();

    const tick = () => {
      if (cancelled) return;
      const container = containerRef.current;
      // Re-read the ref each frame: a re-render can replace the highlighted
      // element, and centring a detached node does nothing.
      const target = currentMatchRef.current;
      if (!container || !target || userIsDriving(touchDraggingRef, lastGestureAtRef)) return;

      const height = container.scrollHeight;
      if (height === lastHeight) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
        lastHeight = height;
        // Instant, not smooth: a second smooth scroll would restart the easing
        // and the match would drift for as long as the groups keep resolving.
        target.scrollIntoView({ block: "center" });
      }

      if (stableFrames < STABLE_FRAMES && now() - start < MAX_SCROLL_SETTLE_MS) {
        window.requestAnimationFrame(tick);
      }
    };

    window.requestAnimationFrame(tick);
    return () => { cancelled = true; };
  }, [currentMatch]);

  return { containerRef, contentRef, currentMatchRef };
}
