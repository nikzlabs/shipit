/**
 * Background→foreground detection for the two long-lived connections (the
 * per-session WebSocket and the global SSE stream).
 *
 * Both connections force a brand-new socket when the app returns from the
 * background, because a mobile OS silently kills a backgrounded TCP connection
 * without telling the JS layer: `readyState` keeps reading OPEN over a socket
 * that will never deliver another byte, so waiting for an `error`/`close` that
 * never fires strands the UI on stale data until a full page reload. The
 * recovery therefore cannot be gated on the connection *looking* unhealthy —
 * it has to be driven by page-lifecycle events.
 *
 * The trap that gave us: **the window `focus` event is not a foreground
 * signal.** It also fires whenever focus returns from an iframe to the
 * top-level document — and the preview iframe does exactly that on every load,
 * after which `MessageInput` deliberately reclaims focus to the textarea
 * (an involuntary load-time steal), firing `focus` again. With `focus` wired
 * straight to "reconnect", each preview reload tore down a perfectly healthy
 * socket, and the coalesce window below turned the storm into exactly one
 * forced reconnect per second on BOTH channels. Every one of those re-ran the
 * whole attach burst (`loadSessionHistory`, uploads, skills, docs, compose and
 * `preview_status` replay) — the preview flicker — while the composer flipped
 * disabled/enabled with the socket status.
 *
 * So the events are split by what they actually prove:
 *
 *  - `visibilitychange` → visible, `pageshow` (bfcache restore) and `online`
 *    are unambiguous resumes. They always reconnect.
 *  - `focus` proves nothing on its own. It reconnects only when there is an
 *    unconsumed background→foreground transition to justify it (the page went
 *    hidden / was frozen / was hidden away to bfcache since the last
 *    reconnect), or when the connection is already gone anyway — in which case
 *    there is no healthy socket to lose and returning to the window is a good
 *    moment to short-circuit the backoff. **A live connection is never torn
 *    down by a bare `focus`.**
 *
 * `pagehide` and `freeze` never fire on an iframe focus change, so they are
 * safe evidence of a real background transition and are recorded as such —
 * they cover the standalone-PWA app-switch where the resume itself surfaces as
 * `focus` rather than `visibilitychange`.
 */

import { useRef } from "react";
import { useEventListeners } from "./useEventListener.js";

/**
 * One window reactivation fires several of these listeners within a few
 * milliseconds of each other (`visibilitychange` + `focus` always, plus
 * `pageshow` on a bfcache restore). Treat the burst as one signal: the first
 * event reconnects, the rest are no-ops. Every extra connection is another
 * server-side attach and another `loadSessionHistory` — which is how two
 * history loads end up in flight at once (see `historyLoadSeq` in
 * `session-data.ts` for what that does to the transcript).
 */
export const FOREGROUND_COALESCE_MS = 1000;

export interface ForegroundSignalOptions {
  /**
   * `false` detaches every listener (a clean no-op), for a hook whose
   * connection is conditionally absent — `useWebSocket`'s null `url`.
   */
  enabled?: boolean;
  /** Run for a genuine resume. Expected to open a fresh connection. */
  onForeground: () => void;
  /**
   * Whether the connection currently exists and is OPEN or still CONNECTING.
   * Consulted ONLY to let a bare `focus` recover a connection that is already
   * dead; a `true` answer is what protects a healthy socket from the iframe
   * focus storm. Note this is a `readyState` read, so it is exactly the answer
   * that lies on a backgrounded mobile socket — which is why it can never be
   * the sole trigger.
   */
  isConnectionLive: () => boolean;
}

export function useForegroundSignal({
  enabled = true,
  onForeground,
  isConnectionLive,
}: ForegroundSignalOptions): void {
  const lastForegroundRef = useRef(0);
  /**
   * An observed background transition that has not yet been paid out as a
   * reconnect. Set by the events that prove the page really went away; cleared
   * the moment a reconnect fires, so one backgrounding buys one reconnect.
   */
  const pendingBackgroundRef = useRef(false);

  // Touches refs and calls the latest props only — safe to re-create per
  // render and hand to `useEventListeners`, which reads handlers through a ref.
  function reconnect(): void {
    if (document.hidden) return;
    const now = Date.now();
    if (now - lastForegroundRef.current < FOREGROUND_COALESCE_MS) return;
    lastForegroundRef.current = now;
    pendingBackgroundRef.current = false;
    onForeground();
  }

  function markBackgrounded(): void {
    pendingBackgroundRef.current = true;
  }

  function handleVisibilityChange(): void {
    if (document.hidden) {
      markBackgrounded();
      return;
    }
    reconnect();
  }

  function handleFocus(): void {
    // The iframe-focus-return case: nothing says the page was away, and the
    // connection is fine. Reconnecting here is the bug, not the feature.
    if (!pendingBackgroundRef.current && isConnectionLive()) return;
    reconnect();
  }

  const doc = enabled ? document : null;
  const win = enabled ? window : null;
  useEventListeners([
    { target: doc, type: "visibilitychange", handler: handleVisibilityChange },
    // Evidence-only: these mark a real background transition but never
    // reconnect on their own (the page is on its way out, not coming back).
    { target: win, type: "pagehide", handler: markBackgrounded },
    { target: doc, type: "freeze", handler: markBackgrounded },
    // Unambiguous resumes.
    { target: win, type: "pageshow", handler: reconnect },
    { target: win, type: "online", handler: reconnect },
    // Conditional — see `handleFocus`.
    { target: win, type: "focus", handler: handleFocus },
  ]);
}
