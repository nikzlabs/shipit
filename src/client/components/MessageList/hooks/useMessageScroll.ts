// eslint-disable-next-line no-restricted-imports -- useEffect/useLayoutEffect: DOM scroll sync, window keydown listener, xterm auto-scroll
import { useEffect, useLayoutEffect, useRef, useCallback } from "react";
import type { SearchMatch } from "../../../hooks/useSearch.js";
import type { ChatMessage } from "../types.js";

const BOTTOM_THRESHOLD_PX = 40;

// this many consecutive frames (layout settled), or until the safety cap.
const STABLE_FRAMES = 3;
const MAX_SCROLL_SETTLE_MS = 1000;

const GESTURE_GRACE_MS = 400;

/**
 * planning#595 — how long a session goes on being "opening" after its
 * conversation first renders. See `openUntilRef`.
 *
 * Measured rather than picked: in the dogfood instance, over a 900-message
 * transcript with a 1,094px status card, the layout effect's pin landed at
 * 79,714 of a real 84,075 and the `content-visibility` groups finished growing
 * 760ms later. 1.5s clears that with room for a slower machine, and it is short
 * enough that the reader is still reading rather than acting. Any real gesture
 * ends the hold at once, so this is the bound on the case where the reader does
 * nothing at all.
 */
const OPENING_HOLD_MS = 1500;

function isNearBottom(container: HTMLElement): boolean {
  const { scrollTop, scrollHeight, clientHeight } = container;
  return scrollHeight - scrollTop - clientHeight < BOTTOM_THRESHOLD_PX;
}

function scrollToBottom(container: HTMLElement): void {
  container.scrollTop = container.scrollHeight;
}

function hasActiveSelectionInside(container: HTMLElement | null): boolean {
  if (!container || typeof window === "undefined") return false;
  const selection = window.getSelection();
  return Boolean(
    selection && !selection.isCollapsed && selection.anchorNode && container.contains(selection.anchorNode),
  );
}

// settle loop's safety cap unreachable and leave every gesture grace window

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
function scheduleScrollToBottom(
  container: HTMLElement,
  shouldContinue: () => boolean,
  // Pins AND records the position as ours, so a `scroll` event reporting it back
  // is not mistaken for the reader's (see `pinnedTopRef`).
  pin: () => void,
): () => void {
  let cancelled = false;
  let lastHeight = -1;
  let stableFrames = 0;
  const start = now();

  const tick = () => {
    if (cancelled || !shouldContinue()) return;
    pin();

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

export function useMessageScroll(
  messages: ChatMessage[],
  isLoading: boolean,
  currentMatch: SearchMatch | undefined,
  sessionId: string | null,
): {
  containerRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  currentMatchRef: React.RefObject<HTMLElement | null>;
  canRestoreReadingAnchor: () => boolean;
  canPreserveAcrossCardMove: () => boolean;
} {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const previousMessageCountRef = useRef(0);
  const currentMatchRef = useRef<HTMLElement | null>(null);

  const cancelSettleRef = useRef<(() => void) | null>(null);

  // event land? `-Infinity` so a freshly-mounted hook is never inside the grace

  const touchDraggingRef = useRef(false);
  const lastGestureAtRef = useRef(-Infinity);

  const shownSessionRef = useRef<string | null>(sessionId);

  /**
   * planning#595 — until when is the session still OPENING?
   *
   * `Infinity` from a displayed-session change and from mount, since the
   * loading gap lasts as long as the history does; `OPENING_HOLD_MS` past the
   * commit that first puts a conversation on screen; `-Infinity` once the
   * reader has taken the scroll.
   *
   * An open needs its own state because landing at the end is not one act: the
   * layout effect's pin measures a `content-visibility` ESTIMATE of a
   * conversation that has not painted, and the corrections that close the gap
   * arrive hundreds of milliseconds later and are individually conditional. A
   * deadline rather than "the height settled", because a group sits at its
   * estimate for some frames and then jumps, so a settled height is not
   * evidence of a finished layout. Numbers and the rest of the rationale:
   * docs/303-session-status-card/plan.md.
   *
   * **One rule ends it: the view is at a position this hook did not write**
   * (`pinnedTopRef`) — so a scrollbar drag, a PageDown, a wheel and a touch
   * drag all reach it through the same test, the loading gap included, where a
   * card taller than the viewport is worth scrolling. A gesture that moves
   * nothing is not the reader taking the view, which is why the position
   * decides and the gesture does not.
   *
   * A text SELECTION is neither suspended nor cleared here: it stands every
   * pinning path down during an open as at any other moment. Only the session
   * switch clears one, because the conversation it was made in has gone.
   */
  const openUntilRef = useRef(Infinity);
  const isOpening = () => now() < openUntilRef.current;

  /**
   * The scroll position this hook itself last wrote, so a `scroll` event can be
   * told from the reader's. Read back from the container rather than assumed,
   * because `scrollTop` is clamped to the scrollable range and is fractional on
   * a scaled display.
   *
   * It is a coordinate, not proof of ownership. The browser moves the view
   * too — clamping when content shrinks, and scroll anchoring when it grows
   * above the viewport — and those end the open early. Both normally land at or
   * near the bottom, where auto-follow stays on and the observer goes on
   * correcting, so the cost is a shortened hold rather than a stranded view.
   * Nothing here touches anything but refs and the argument, so the
   * `[]`-dependency effect may hold the first render's copy.
   */
  const pinnedTopRef = useRef(-1);
  const pin = (container: HTMLElement) => {
    scrollToBottom(container);
    pinnedTopRef.current = container.scrollTop;
  };

  // scroll take authoritative control — we must never fight a user's scroll.
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      // While the session is opening, a position WE wrote is not news: the pin
      // lands on an estimated height and the real one arrives frames later, so
      // reading it back says "scrolled away" about a conversation nobody has
      // touched — and recording that stands down every path that closes the
      // gap. A position we did not write is the reader's, wherever it came
      // from, and it ends the open. This is the only place the open ends.
      if (isOpening()) {
        if (container.scrollTop === pinnedTopRef.current) return;
        openUntilRef.current = -Infinity;
      }
      const near = isNearBottom(container);
      autoScrollRef.current = near;

      if (!near) cancelSettleRef.current?.();
    };

    // `wheel`/`touchmove` fire only from genuine user input — never from a

    // never overridden, and stamp the gesture so the OTHER two auto-scroll paths

    const handleManualScroll = () => {
      // Deliberately does NOT end the open: a gesture that moved nothing is not
      // the reader taking the view, and the scroll it does produce ends it
      // through `handleScroll` a moment later. One rule, one place.
      lastGestureAtRef.current = now();
      cancelSettleRef.current?.();
    };

    // no end event, so a sticky flag set here would never clear and would suppress

    const handleTouchMove = () => {
      touchDraggingRef.current = true;
      handleManualScroll();
    };

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

    // when it paints, which the container's own box never reflects, so watching

    // produce, so `handleScroll` never sees a position stranded by our own pin
    // and never mistakes it for the user scrolling away.

    const observer = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          // During the open this is the correction that closes the estimate, so
          // it answers to the open rather than to flags describing the reader of
          // a conversation that was not on screen yet. A selection is not one of
          // those flags: the open clears the ones it may disregard, so any that
          // is live here was made in the conversation now on screen.
          if (isOpening()) {
            if (!hasActiveSelectionInside(container)) pin(container);
            return;
          }
          if (userIsDriving(touchDraggingRef, lastGestureAtRef)) return;
          if (autoScrollRef.current && !hasActiveSelectionInside(container)) pin(container);
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

  useLayoutEffect(() => {
    /**
     * planning#595 — a session that opens lands at the end of its conversation,
     * whatever the reader had done to the PREVIOUS one.
     *
     * These refs describe one reader in one transcript, and the hook is never
     * remounted across a switch. Left alone they carry the outgoing reader's
     * position in: `autoScrollRef` false makes this effect bail AND the
     * observer decline, so nothing pins the incoming transcript. The clamp that
     * used to repair that by accident needs a scroll position to clamp from,
     * and the status card is content the transcript's clearing does not remove
     * — it renders from the session record — so the loading view stays
     * scrollable as far as the card is tall and no clamp happens. Measured both
     * ways; docs/303-session-status-card/plan.md has the numbers.
     *
     * Keyed on the session's identity rather than on observing the switch, so a
     * viewer that misses an intermediate render still resets (docs/095) — and
     * done HERE rather than during render, because a deferred render can be
     * abandoned: these refs drive listeners that are live on the transcript
     * still displayed, and writing them from a render that never commits pins
     * the OUTGOING session to its bottom under a reader who did not ask for it.
     */
    if (shownSessionRef.current !== sessionId) {
      shownSessionRef.current = sessionId;
      // The open begins here, on the gap's ceiling until the conversation is on
      // screen to start the real hold.
      openUntilRef.current = Infinity;
      autoScrollRef.current = true;
      touchDraggingRef.current = false;
      lastGestureAtRef.current = -Infinity;
      previousMessageCountRef.current = 0;
      // And the reader's SELECTION, which every pinning path stands down for.
      // Clearing the transcript does not end one: the card keeps its DOM across
      // the switch, so a selection made inside it is still inside the container
      // afterwards and would hold the incoming conversation off its end for as
      // long as it lasts. A click normally collapses a selection, which is why
      // this only shows up when the session is opened without one — the back
      // button, a keyboard switch, a link. It belongs to a conversation that is
      // no longer on screen either way.
      if (hasActiveSelectionInside(containerRef.current)) {
        window.getSelection()?.removeAllRanges();
      }
    }

    const previousMessageCount = previousMessageCountRef.current;
    previousMessageCountRef.current = messages.length;
    const latestMessage = messages[messages.length - 1];
    // `previousMessageCount > 0` is what separates an APPEND from the arrival of
    // a whole history. Without it, hydrating a conversation whose last row
    // happens to be a user message reads as "the reader has just sent
    // something" — and that exception is the strongest one there is: it
    // overrides the follow flag AND clears the gesture state. So opening a
    // session that is mid-turn, before its first reply, threw a reader who had
    // scrolled the loading card back to the end. Found in review of
    // planning#595; the hydration/append confusion is older.
    const appendedUserMessage = previousMessageCount > 0
      && messages.length > previousMessageCount
      && latestMessage?.role === "user";

    // The open's deadline starts at the commit that first puts a conversation
    // on screen — not at the switch, since the loading gap lasts as long as the
    // history takes and none of it is time the reader has had the conversation.
    if (isOpening() && previousMessageCount === 0 && messages.length > 0) {
      openUntilRef.current = now() + OPENING_HOLD_MS;
    }

    // No `opening` term here on purpose: an open begins with `autoScrollRef`
    // true and the one path that clears it ends the open in the same breath, so
    // "opening and not following" cannot happen.
    if (!autoScrollRef.current && !appendedUserMessage) return;

    if (appendedUserMessage) {
      touchDraggingRef.current = false;
      lastGestureAtRef.current = -Infinity;
    } else if (userIsDriving(touchDraggingRef, lastGestureAtRef)) {
      return;
    }
    if (hasActiveSelectionInside(containerRef.current)) return;
    const container = containerRef.current;
    if (!container) return;

    pin(container);
    autoScrollRef.current = true;

    const cancel = scheduleScrollToBottom(container, () => {
      const latestContainer = containerRef.current;
      if (latestContainer !== container) return false;
      // A selection stands this loop down like every other pinning path. It
      // never did, which is how a loop already running could walk content out
      // from under a selection made after it started — found in review, and
      // covered by `useMessageScroll.test.tsx`.
      if (hasActiveSelectionInside(container)) return false;
      if (userIsDriving(touchDraggingRef, lastGestureAtRef)) return false;
      return autoScrollRef.current;
    }, () => pin(container));
    cancelSettleRef.current = cancel;
    return () => {
      cancel();
      if (cancelSettleRef.current === cancel) cancelSettleRef.current = null;
    };
  }, [messages, isLoading, sessionId]);

  // auto` sits on GROUPS of 20 rows, and a group that has never been on screen

  // Bottom-pinning never had this problem because its ResizeObserver corrects

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

      const target = currentMatchRef.current;
      if (!container || !target || userIsDriving(touchDraggingRef, lastGestureAtRef)) return;

      const height = container.scrollHeight;
      if (height === lastHeight) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
        lastHeight = height;

        target.scrollIntoView({ block: "center" });
      }

      if (stableFrames < STABLE_FRAMES && now() - start < MAX_SCROLL_SETTLE_MS) {
        window.requestAnimationFrame(tick);
      }
    };

    window.requestAnimationFrame(tick);
    return () => { cancelled = true; };
  }, [currentMatch]);

  const canRestoreReadingAnchor = useCallback(() => !autoScrollRef.current
    && !hasActiveSelectionInside(containerRef.current)
    && !userIsDriving(touchDraggingRef, lastGestureAtRef), []);

  /**
   * docs/303-session-status-card req 30 — whether the status card returning to
   * the end of the conversation must keep the reader's row where it is.
   *
   * It asks the container, not `autoScrollRef`. The flag is deliberately sticky
   * — an appended user message sets it true and pins, so that the settle loop
   * can keep pinning while a tall row paints — and a dispatched turn's own user
   * row goes through that path too. So it can read true while the view sits
   * thousands of pixels above the bottom, and the card's move changes no
   * height, so no ResizeObserver corrects it: the reader's row would simply
   * jump by the card's height. Near the bottom nothing is needed, since the
   * move leaves `scrollHeight` alone.
   *
   * A live text SELECTION is not a reason to stand down, unlike the auto-scroll
   * paths: those would move content the user is holding still, while this one
   * cancels a displacement they did not ask for — a selection below the card is
   * exactly what the card's departure drags out from under the cursor. A live
   * scroll GESTURE still is: writing `scrollTop` into a fling fights it, and a
   * reader mid-fling is not holding a row.
   */
  const canPreserveAcrossCardMove = useCallback(() => {
    const container = containerRef.current;
    return !!container
      && !isNearBottom(container)
      && !userIsDriving(touchDraggingRef, lastGestureAtRef);
  }, []);

  return { containerRef, contentRef, currentMatchRef, canRestoreReadingAnchor, canPreserveAcrossCardMove };
}
