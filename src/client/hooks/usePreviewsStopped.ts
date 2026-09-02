/**
 * "Session X's previews have stopped" — a cross-session signal, delivered to
 * whichever component owns the iframe pool (planning#496).
 *
 * The iframe pool keeps one iframe per `(session, port)` mounted so returning
 * to a session is instant, and since planning#492 each of those holds its own
 * renderer process. That retention only pays off while the preview is still
 * being served: once a session's Compose stack is torn down, the document is
 * talking to containers that no longer exist and `PreviewFrame` reloads the
 * slot when the services come back (planning#478) rather than showing the stale
 * page. So a slot in that state is a process held for nothing.
 *
 * Shaped like `useSessionNetworkMode`'s notifier for the same reason: the fact
 * arrives on the GLOBAL SSE stream (it is about a session the viewer is not
 * looking at), while the thing that must react is component state inside
 * `PreviewFrame`. A module-level listener set is the channel between them —
 * the store would be the wrong home, because nothing here is state anyone
 * renders, only an event someone acts on once.
 */

// eslint-disable-next-line no-restricted-imports -- useEffect: subscribing to a module-level listener set fed by the global SSE stream, an external system outside React's tree
import { useEffect, useRef } from "react";

type Listener = (sessionId: string) => void;

const listeners = new Set<Listener>();

/**
 * Announce that a session's previews stopped. Called by the SSE handler for
 * `session_previews_stopped`.
 */
export function notifyPreviewsStopped(sessionId: string): void {
  for (const listener of listeners) listener(sessionId);
}

/**
 * Run `handler` whenever some session's previews stop.
 *
 * The handler is read through a ref, so passing a fresh inline arrow every
 * render does not churn the subscription — same latest-callback shape as
 * `useEventListener`, which this cannot reuse because the source is a module
 * set rather than an `EventTarget`.
 */
export function usePreviewsStopped(handler: Listener): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  // eslint-disable-next-line no-restricted-syntax -- external system sync: subscribing to a module-level listener set, which is not React state
  useEffect(() => {
    const listener: Listener = (sessionId) => handlerRef.current(sessionId);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
}

/**
 * Release the iframe-pool slots of any session whose previews have stopped.
 *
 * The rule this encodes, and the reason it lives here rather than inline in
 * `PreviewFrame`: the ACTIVE session is never touched. Its preview dying is
 * already handled where the user can see it — `waitingForService` holds the
 * pane on its service and reloads when it comes back (planning#478) — and
 * dropping the iframe the user is currently looking at is the one thing the
 * pool must never do. So this can only ever reclaim background slots.
 *
 * @param activeSessionId The session the pane is currently showing, if any.
 * @param dropSessionSlots {@link IframePool.dropSessionSlots}.
 */
export function useReleaseStoppedPreviews(
  activeSessionId: string | undefined,
  dropSessionSlots: (sessionId: string) => string[],
): void {
  usePreviewsStopped((stoppedSessionId) => {
    if (stoppedSessionId === activeSessionId) return;
    dropSessionSlots(stoppedSessionId);
  });
}

/** Test-only: drop every subscriber so one case cannot leak into the next. */
export function _resetPreviewsStoppedListeners(): void {
  listeners.clear();
}
