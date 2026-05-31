// eslint-disable-next-line no-restricted-imports -- useEffect: WebSocket connection lifecycle with cleanup and reconnection (external system sync)
import { useRef, useEffect, useCallback, useState } from "react";

export type WsStatus = "connecting" | "open" | "closed";

export interface UseWebSocketReturn {
  send: (data: unknown) => void;
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

  const clearForegroundRetryTimers = useCallback(() => {
    for (const timer of foregroundRetryTimersRef.current) {
      clearTimeout(timer);
    }
    foregroundRetryTimersRef.current = [];
  }, []);

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
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

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
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
  // an aggressive short retry burst before falling back to normal backoff.
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (!url) return;
    function handleForeground() {
      if (!document.hidden) {
        reconnectForForeground();
      }
    }
    function handleVisibilityChange() {
      handleForeground();
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handleForeground);
    window.addEventListener("focus", handleForeground);
    window.addEventListener("online", handleForeground);
    return () => {
      clearForegroundRetryTimers();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handleForeground);
      window.removeEventListener("focus", handleForeground);
      window.removeEventListener("online", handleForeground);
    };
  }, [url, reconnectForForeground, clearForegroundRetryTimers]);

  const drainMessages = useCallback((): MessageEvent[] => {
    const msgs = messageQueueRef.current;
    messageQueueRef.current = [];
    return msgs;
  }, []);

  return { send, lastMessage, drainMessages, status, reconnectAttempt, reconnect };
}
