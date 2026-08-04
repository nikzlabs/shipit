// eslint-disable-next-line no-restricted-imports -- useEffect: WebSocket connection lifecycle with cleanup and reconnection (external system sync)
import { useRef, useEffect, useCallback, useState } from "react";
import { useEventListeners } from "./useEventListener.js";

export type WsStatus = "connecting" | "open" | "closed";

export interface UseWebSocketReturn {
  /**
   * Put a frame on the wire. Returns `true` only if the bytes were actually
   * handed to an OPEN socket, `false` if the send was dropped (socket absent,
   * connecting, closing, closed, or `ws.send` threw).
   *
   * Callers MUST NOT assume delivery: a `void` return here is what let the
   * action-checklist card render "Submitted · N sent" for a frame that never
   * left the browser. Anything that shows the user a confirmation has to gate
   * it on this boolean (see `sendUserMessage`).
   *
   * Caveat — `true` means "written to an OPEN socket", not "the server got it".
   * A backgrounded mobile socket can read OPEN while the OS has already killed
   * the connection, so the bytes vanish silently. Closing that hole needs a
   * server-side ack keyed on `requestId`; this boolean only guarantees the ack
   * can never outrun the wire.
   */
  send: (data: unknown) => boolean;
  /**
   * The most recent WebSocket message. Used as a React render trigger — when
   * multiple messages arrive between renders, only the last one is visible here.
   * Use {@link drainMessages} to process every message without drops.
   */
  lastMessage: MessageEvent | null;
  /**
   * Drain all messages that arrived since the last drain. Returns and clears
   * the internal queue. This guarantees no messages are lost even when React
   * batches multiple `setLastMessage` calls between renders.
   */
  drainMessages: () => MessageEvent[];
  status: WsStatus;
  /** Number of consecutive reconnect attempts since last successful connection. */
  reconnectAttempt: number;
  /** Manually trigger an immediate reconnect (resets backoff timer). */
  reconnect: () => void;
}

/**
 * Exponential backoff: 2s, 4s, 8s, 16s, capped at 30s.
 * Jitter is intentionally omitted — a single browser tab doesn't cause thundering-herd.
 */
function backoffMs(attempt: number): number {
  return Math.min(2000 * Math.pow(2, attempt), 30_000);
}

/**
 * Window reactivation fires `visibilitychange`, `focus` and (on bfcache
 * restore) `pageshow` within a few milliseconds of each other. Treat them as
 * one signal — see `handleForeground`.
 */
const FOREGROUND_COALESCE_MS = 1000;

export function useWebSocket(url: string | null): UseWebSocketReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<WsStatus>(url ? "connecting" : "closed");
  const [lastMessage, setLastMessage] = useState<MessageEvent | null>(null);
  const messageQueueRef = useRef<MessageEvent[]>([]);
  const [connectAttempt, setConnectAttempt] = useState(0);
  const reconnectAttemptRef = useRef(0);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const foregroundRetryTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const lastForegroundReconnectRef = useRef(0);

  const clearForegroundRetryTimers = useCallback(() => {
    for (const timer of foregroundRetryTimersRef.current) {
      clearTimeout(timer);
    }
    foregroundRetryTimersRef.current = [];
  }, []);

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    // A queued message belongs to the socket generation that received it.
    // Session switches change `url`, but React may not run the consumer effect
    // until after this hook has torn down the old socket. Never let an
    // undrained event from the outgoing session cross that boundary and render
    // in the incoming session's transcript.
    messageQueueRef.current = [];
    setLastMessage(null);

    if (!url) {
      setStatus("closed");
      return;
    }

    // Guard against React StrictMode double-mount: when cleanup closes the WS,
    // onclose must NOT schedule a reconnect (the remounted effect will open a
    // fresh connection).
    let intentionalClose = false;

    const ws = new WebSocket(url);
    wsRef.current = ws;
    setStatus("connecting");

    ws.onopen = () => {
      if (intentionalClose) {
        ws.close();
        return;
      }
      setStatus("open");
      reconnectAttemptRef.current = 0;
      setReconnectAttempt(0);
      clearForegroundRetryTimers();
    };

    ws.onclose = () => {
      if (intentionalClose) return;
      setStatus("closed");
      const attempt = reconnectAttemptRef.current;
      reconnectAttemptRef.current = attempt + 1;
      setReconnectAttempt(attempt + 1);

      const delay = backoffMs(attempt);
      reconnectTimerRef.current = setTimeout(
        () => setConnectAttempt((n) => n + 1),
        delay,
      );
    };

    ws.onmessage = (event) => {
      messageQueueRef.current.push(event);
      setLastMessage(event);
    };

    return () => {
      intentionalClose = true;
      messageQueueRef.current = [];
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      ws.onopen = null;
      ws.onclose = null;
      ws.onmessage = null;
      if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
        ws.close();
      }
    };
  }, [url, connectAttempt, clearForegroundRetryTimers]);

  const send = useCallback((data: unknown): boolean => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return false;
    try {
      wsRef.current.send(JSON.stringify(data));
      return true;
    } catch {
      // `ws.send` throws InvalidStateError if the socket transitioned between
      // the readyState check and the write. A dropped frame is a dropped frame.
      return false;
    }
  }, []);

  const openFreshSocket = useCallback(() => {
    // Clear any pending backoff timer and trigger an immediate reconnect
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    // Reset attempt counter so the next auto-reconnect starts fresh
    reconnectAttemptRef.current = 0;
    setReconnectAttempt(0);
    setConnectAttempt((n) => n + 1);
  }, []);

  const reconnect = useCallback(() => {
    clearForegroundRetryTimers();
    openFreshSocket();
  }, [clearForegroundRetryTimers, openFreshSocket]);

  const reconnectForForeground = useCallback(() => {
    clearForegroundRetryTimers();
    openFreshSocket();
    for (const delay of [300, 1200, 3000]) {
      const timer = setTimeout(() => {
        if (document.hidden) return;
        if (wsRef.current?.readyState === WebSocket.OPEN) return;
        openFreshSocket();
      }, delay);
      foregroundRetryTimersRef.current.push(timer);
    }
  }, [clearForegroundRetryTimers, openFreshSocket]);

  // Force a fresh WebSocket when the tab returns from the background. Mobile
  // OSes silently kill or stall backgrounded TCP sockets without notifying the
  // JS layer; the WebSocket's readyState can remain OPEN or CONNECTING even
  // though a reload would immediately recover. Foreground lifecycle events use
  // an aggressive short retry burst before falling back to normal backoff. A
  // null target while `url` is absent reproduces the old `if (!url) return` gate.
  //
  // One window reactivation fires several of these listeners in quick
  // succession — `visibilitychange` and `focus` always, plus `pageshow` on a
  // bfcache restore — and each used to tear the socket down and open another.
  // Every extra socket is another server-side attach and another
  // `loadSessionHistory`, which is exactly how two history loads end up in
  // flight at once (see `historyLoadSeq` in `session-data.ts` for what that
  // does to the transcript). Coalesce the burst: the first event reconnects,
  // the rest are no-ops. A connect that doesn't take is still covered — by the
  // 300/1200/3000ms retries below and then by normal backoff.
  function handleForeground() {
    if (document.hidden) return;
    const now = Date.now();
    if (now - lastForegroundReconnectRef.current < FOREGROUND_COALESCE_MS) return;
    lastForegroundReconnectRef.current = now;
    reconnectForForeground();
  }
  useEventListeners([
    { target: url ? document : null, type: "visibilitychange", handler: handleForeground },
    { target: url ? window : null, type: "pageshow", handler: handleForeground },
    { target: url ? window : null, type: "focus", handler: handleForeground },
    { target: url ? window : null, type: "online", handler: handleForeground },
  ]);
  // The listener effect previously cleared the foreground retry timers on url
  // change / unmount; useEventListeners owns only add/remove, so keep that
  // teardown on the same [url] cadence so a stale retry can't fire post-switch.
  // eslint-disable-next-line no-restricted-syntax -- non-listener cleanup (clear foreground retry timers on url change/unmount)
  useEffect(() => () => clearForegroundRetryTimers(), [url, clearForegroundRetryTimers]);

  const drainMessages = useCallback((): MessageEvent[] => {
    const msgs = messageQueueRef.current;
    messageQueueRef.current = [];
    return msgs;
  }, []);

  return { send, lastMessage, drainMessages, status, reconnectAttempt, reconnect };
}
