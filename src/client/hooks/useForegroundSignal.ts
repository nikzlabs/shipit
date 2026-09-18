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

export const FOREGROUND_COALESCE_MS = 1000;

export interface ForegroundSignalOptions {

  enabled?: boolean;

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

type BlurKind = "internal" | "external" | "none";

export function useForegroundSignal({
  enabled = true,
  onForeground,
  isConnectionLive,
}: ForegroundSignalOptions): void {
  const lastForegroundRef = useRef(0);

  const pendingBackgroundRef = useRef(false);
  const lastBlurRef = useRef<BlurKind>("none");

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

    lastBlurRef.current = document.hasFocus() ? "internal" : "external";
  }

  function handleFocus(): void {

    if (pendingBackgroundRef.current) {
      reconnect();
      return;
    }

    const priorBlur = lastBlurRef.current;
    lastBlurRef.current = "none";

    // `MessageInput` took it back). The page never went anywhere and the

    if (priorBlur === "internal") return;

    if (priorBlur === "external") {
      reconnect();
      return;
    }

    if (!isConnectionLive()) reconnect();
  }

  const doc = enabled ? document : null;
  const win = enabled ? window : null;
  useEventListeners([
    { target: doc, type: "visibilitychange", handler: handleVisibilityChange },
    // Evidence-only: these mark a real background transition but never

    { target: win, type: "pagehide", handler: markBackgrounded },
    { target: doc, type: "freeze", handler: markBackgrounded },
    { target: win, type: "blur", handler: handleBlur },

    { target: win, type: "pageshow", handler: reconnect },
    { target: win, type: "online", handler: reconnect },

    { target: win, type: "focus", handler: handleFocus },
  ]);
}
