// eslint-disable-next-line no-restricted-imports -- useEffect: one-shot measurement of a browser API on mount (external system sync)
import { useEffect } from "react";
import { useEventListeners } from "./useEventListener.js";

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
 * That is exactly what an installed PWA does after it resumes from an
 * externally-opened window (tapping "open preview in a new tab" hands off to an
 * in-app browser / Custom Tab; dismissing it returns to the PWA). The resume
 * does not reliably re-resolve `dvh` — the shell keeps the height it had before
 * the hand-off, the tab bar sits below the fold, and `overflow: hidden` means
 * the user cannot scroll down to it. Re-measuring on every resume replaces the
 * stale value with the live one.
 *
 * `window.innerHeight` — the layout viewport — is deliberately the measurement,
 * NOT `visualViewport.height`. It is the direct analogue of `dvh`, so binding to
 * it changes nothing about how the shell behaves when the soft keyboard opens
 * (Chrome's `interactive-widget=resizes-content` shrinks the layout viewport and
 * the shell follows, as it did before; iOS leaves it alone and the shell stays
 * put, as it did before). Using `visualViewport` would newly collapse the shell
 * around the iOS keyboard — a different change, not this fix.
 *
 * The scroll reset covers the sibling failure: iOS scrolls the *document* to
 * reveal a focused input even under `overflow: hidden`, and a resume can leave
 * it parked there with the tab bar pushed out of view. The shell is never meant
 * to scroll, so returning to the app returns it to the top — unless an editable
 * element is focused, where that offset is the keyboard doing its job.
 */
export function useAppViewportHeight(): void {
  // eslint-disable-next-line no-restricted-syntax -- measure once on mount; the listeners below only cover *changes*
  useEffect(() => {
    syncAppViewportHeight();
  }, []);

  const sync = () => syncAppViewportHeight();

  useEventListeners([
    { target: window, type: "resize", handler: sync },
    { target: window, type: "orientationchange", handler: sync },
    // The resume signals. `pageshow` covers a bfcache restore, `focus` a
    // standalone-PWA app switch, `visibilitychange` a plain tab return — the
    // same set the WS/SSE reconnect paths listen for, and for the same reason:
    // no single one of them fires on every platform's resume.
    { target: window, type: "pageshow", handler: sync },
    { target: window, type: "focus", handler: sync },
    { target: document, type: "visibilitychange", handler: sync },
    // Fires on soft-keyboard show/hide and pinch-zoom. Measuring here is a
    // no-op on platforms where `innerHeight` didn't move; it matters on the
    // ones that resize the layout viewport a frame after the visual one.
    { target: typeof window === "undefined" ? null : window.visualViewport, type: "resize", handler: sync },
  ]);
}

/** Write the current viewport height into `--app-height` and unpark the document. */
export function syncAppViewportHeight(): void {
  if (typeof window === "undefined") return;
  const height = window.innerHeight;
  // A zero/NaN reading (some browsers report it mid-resume) would collapse the
  // whole shell. Leave the previous value — or the `100dvh` default — in place.
  if (Number.isFinite(height) && height > 0) {
    document.documentElement.style.setProperty("--app-height", `${height}px`);
  }
  if (window.scrollY !== 0 && !isEditableFocused()) window.scrollTo(0, 0);
}

function isEditableFocused(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA";
}
