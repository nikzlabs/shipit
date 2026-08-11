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
 *  - `visibilitychange` → hidden, `pagehide` and `freeze` cannot be fired by an
 *    iframe focus change, so they are safe evidence that the page really went
 *    away. They only *record* that; the resume itself reconnects.
 *  - `focus` is classified against the `blur` that necessarily preceded it,
 *    because that is where the two cases are actually distinguishable. At blur
 *    time `document.hasFocus()` is **true** when focus merely moved to an
 *    iframe inside this page (the browser window kept system focus) and
 *    **false** when the whole window lost focus to another OS window. Only the
 *    iframe case is suppressed. Verified in a real browser: an iframe click
 *    fires the parent's `blur` with `hasFocus=true`, `activeElement=IFRAME`.
 *
 * Suppressing only the *provably* internal case is deliberate — it is the one
 * ordering that fails safe. Every unclassifiable focus still reconnects, which
 * is the old behaviour, so a browser that reports this differently costs a
 * redundant reconnect rather than a socket stranded dead. That matters because
 * the desktop path this listener uniquely covers — the user works in another
 * application (the browser window is still *visible*, so no
 * `visibilitychange`), the machine sleeps or the network moves under a
 * half-open socket, and the return surfaces as `focus` alone — has no other
 * signal behind it.
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
   * Consulted only for a `focus` with no preceding `blur` to classify it —
   * there it decides between "leave the healthy connection alone" and "nothing
   * to lose, so retry now rather than sit out the backoff". Note this is a
   * `readyState` read, so it is exactly the answer that lies on a backgrounded
   * mobile socket — which is why it can never be the sole trigger.
   */
  isConnectionLive: () => boolean;
}

/**
 * How the last `blur` classified: focus moved to an iframe inside this page
 * (`internal`), the browser window lost system focus (`external`), or no blur
 * has been seen since the last focus was classified (`none`).
 */
type BlurKind = "internal" | "external" | "none";

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
  const lastBlurRef = useRef<BlurKind>("none");

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
    // Open the coalesce window. Without this, a page that goes away again
    // within a second of a resume has its NEXT resume swallowed as if it were
    // part of the previous one's burst — and then nothing reconnects at all,
    // leaving the pending marker stranded to be spent by some unrelated focus
    // much later. The window exists to collapse one reactivation's several
    // events, not to rate-limit genuinely separate reactivations.
    lastForegroundRef.current = 0;
  }

  function handleVisibilityChange(): void {
    if (document.hidden) {
      markBackgrounded();
      return;
    }
    reconnect();
  }

  function handleBlur(): void {
    // See the module docstring: at blur time this is the one reliable read that
    // separates "an iframe in our own page took focus" from "the browser window
    // lost focus".
    lastBlurRef.current = document.hasFocus() ? "internal" : "external";
  }

  function handleFocus(): void {
    // A resume the page-lifecycle events already proved.
    if (pendingBackgroundRef.current) {
      reconnect();
      return;
    }
    // One blur classifies one focus.
    const priorBlur = lastBlurRef.current;
    lastBlurRef.current = "none";
    // The storm: the preview iframe took focus and gave it back (or
    // `MessageInput` took it back). The page never went anywhere and the
    // connection is fine. Reconnecting here is the bug, not the feature.
    if (priorBlur === "internal") return;
    // The window itself lost and regained system focus — a genuine return, and
    // on desktop often the only signal that one happened.
    if (priorBlur === "external") {
      reconnect();
      return;
    }
    // Focus with no blur behind it proves nothing either way, so it may not
    // cost a live connection — but there is nothing to lose if the connection
    // is already gone, and returning to the window is a good moment to stop
    // waiting out the backoff.
    if (!isConnectionLive()) reconnect();
  }

  const doc = enabled ? document : null;
  const win = enabled ? window : null;
  useEventListeners([
    { target: doc, type: "visibilitychange", handler: handleVisibilityChange },
    // Evidence-only: these mark a real background transition but never
    // reconnect on their own (the page is on its way out, not coming back).
    { target: win, type: "pagehide", handler: markBackgrounded },
    { target: doc, type: "freeze", handler: markBackgrounded },
    { target: win, type: "blur", handler: handleBlur },
    // Unambiguous resumes.
    { target: win, type: "pageshow", handler: reconnect },
    { target: win, type: "online", handler: reconnect },
    // Conditional — see `handleFocus`.
    { target: win, type: "focus", handler: handleFocus },
  ]);
}
