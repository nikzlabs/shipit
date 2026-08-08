// eslint-disable-next-line no-restricted-imports -- useEffect: one-shot measurement of a browser API on mount + timer teardown (external system sync)
import { useEffect, useRef } from "react";
import { useEventListeners } from "./useEventListener.js";

/**
 * How long after a resume/resize to re-measure. The event that tells us the app
 * is back does NOT guarantee the window geometry has settled — a browser can
 * fire `pageshow`/`focus` and then finish resizing a frame or two later, at
 * which point our snapshot is the stale value we were trying to replace. So
 * every trigger measures three times: now, next frame, and once more after the
 * window has had time to stop moving.
 */
const SETTLE_MS = 300;

/**
 * Keeps `--app-height` (the app shell's height, see index.css) pinned to the
 * *measured* viewport instead of trusting the CSS `dvh` unit alone.
 *
 * Why this exists: the shell is `height: var(--app-height)` with
 * `html, body { overflow: hidden }`, so anything below the shell's bottom edge
 * is not merely off-screen — it is **unreachable**, with no scroll to recover
 * it. The mobile tab bar (Chat / Workspace / Sessions / New) is the last child
 * of that shell, so a viewport height that over-reports by even a few dozen
 * pixels strands the app's primary navigation with no way back.
 *
 * That is what an installed PWA can do after it resumes from an
 * externally-opened window (tapping "open preview in a new tab" hands off to an
 * in-app browser / Custom Tab; dismissing it returns to the PWA). The resume
 * does not reliably re-resolve `dvh` — the shell keeps the height it had before
 * the hand-off, the tab bar sits below the fold, and `overflow: hidden` means
 * the user cannot scroll down to it.
 *
 * **This trades a live CSS unit for a snapshot, so the snapshot has to be
 * re-taken aggressively.** Once we write a pixel value it stops tracking
 * anything on its own; a single measurement at the wrong moment would freeze
 * the exact staleness we set out to fix. Hence `SETTLE_MS` above, and hence the
 * breadth of the trigger list below. Known WebKit bugs report `innerHeight`
 * going stale *alongside* `dvh` (e.g. webkit.org/b/281063) — where that happens
 * no client-side measurement can help on the first read, and re-measuring after
 * the window settles is the only lever we have.
 *
 * `window.innerHeight` — the layout viewport — is deliberately the measurement,
 * NOT `visualViewport.height`. It is the direct analogue of `dvh`, so binding to
 * it changes nothing about how the shell behaves when the soft keyboard opens
 * (Chrome's `interactive-widget=resizes-content` shrinks the layout viewport and
 * the shell follows, as it did before; iOS leaves it alone and the shell stays
 * put, as it did before). Using `visualViewport` would newly collapse the shell
 * around the iOS keyboard — a different change, not this fix.
 *
 * The scroll reset covers the sibling failure: the viewport can be parked below
 * the top of the document with the tab bar pushed out of view, and
 * `overflow: hidden` leaves no way to scroll back. WebKit does this both by
 * scrolling the root to reveal a focused input (even under `overflow: hidden`)
 * and by panning the *visual* viewport while `scrollY` stays 0
 * (webkit.org/b/311821), so both are checked. It is suppressed in the two cases
 * where the offset is someone's deliberate state rather than a glitch: a
 * pinch-zoomed viewport (the pan is the user's) and a focused editable (the
 * offset is the soft keyboard doing its job — undoing it would scroll the caret
 * back under the keyboard mid-typing).
 */
export function useAppViewportHeight(): void {
  // One pending frame and one pending timer, both coalesced: a burst of resize
  // events schedules one settle-check, not hundreds.
  const frameRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resync = () => {
    syncAppViewportHeight();
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    frameRef.current = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(() => {
        frameRef.current = null;
        syncAppViewportHeight();
      })
      : null;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      syncAppViewportHeight();
    }, SETTLE_MS);
  };

  // eslint-disable-next-line no-restricted-syntax -- measure on mount (the listeners below only cover *changes*) + cancel pending settle-checks on unmount
  useEffect(() => {
    syncAppViewportHeight();
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  useEventListeners([
    { target: window, type: "resize", handler: resync },
    { target: window, type: "orientationchange", handler: resync },
    // The resume signals. `pageshow` covers a bfcache restore, `focus` a
    // standalone-PWA app switch, `visibilitychange` a plain tab return — the
    // same set the WS/SSE reconnect paths listen for, and for the same reason:
    // no single one of them fires on every platform's resume.
    { target: window, type: "pageshow", handler: resync },
    { target: window, type: "focus", handler: resync },
    { target: document, type: "visibilitychange", handler: resync },
    // Fires on soft-keyboard show/hide and pinch-zoom. Measuring here is a
    // no-op on platforms where `innerHeight` didn't move; it matters on the
    // ones that resize the layout viewport a frame after the visual one.
    { target: typeof window === "undefined" ? null : window.visualViewport, type: "resize", handler: resync },
  ]);
}

/** Write the current viewport height into `--app-height` and unpark the document. */
export function syncAppViewportHeight(): void {
  if (typeof window === "undefined") return;
  const height = window.innerHeight;
  // A zero/NaN reading (some browsers report it mid-resume) would collapse the
  // whole shell. Leave the previous value — or the CSS default — in place.
  if (Number.isFinite(height) && height > 0) {
    document.documentElement.style.setProperty("--app-height", `${height}px`);
  }
  if (isViewportParked() && !isFocusHoldingScroll()) window.scrollTo(0, 0);
}

/** Is the viewport showing something other than the top of the shell? */
function isViewportParked(): boolean {
  const vv = window.visualViewport;
  // A pinch-zoomed viewport is panned on purpose — leave it alone. (Note
  // `visualViewport` fires `resize` on a zoom change, so without this a pinch
  // would yank the user back to the top of the page.)
  if (vv && vv.scale > 1) return false;
  if (window.scrollY !== 0) return true;
  return !!vv && vv.offsetTop > 0;
}

/**
 * Is something on screen entitled to hold the viewport off the top? An editable
 * element in this document, or — because a cross-origin preview's own focused
 * input surfaces here only as the iframe element — a focused iframe.
 */
function isFocusHoldingScroll(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLIFrameElement) return true;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA";
}
