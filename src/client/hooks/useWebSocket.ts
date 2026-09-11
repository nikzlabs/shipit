// eslint-disable-next-line no-restricted-imports -- useEffect: WebSocket connection lifecycle with cleanup and reconnection (external system sync)
import { useRef, useEffect, useCallback, useState } from "react";
import { useForegroundSignal } from "./useForegroundSignal.js";

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

  lastMessage: MessageEvent | null;

  drainMessages: () => MessageEvent[];
  status: WsStatus;

  reconnectAttempt: number;

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

  const openedUrlRef = useRef<string | null>(null);

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    openedUrlRef.current = url;

    // until after this hook has torn down the old socket. Never let an

    messageQueueRef.current = [];
    setLastMessage(null);

    if (!url) {
      setStatus("closed");
      return;
    }

    // onclose must NOT schedule a reconnect (the remounted effect will open a

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

      return false;
    }
  }, []);

  const openFreshSocket = useCallback(() => {

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

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

  // why a bare window `focus` must NOT tear this socket down; see its docstring.

  useForegroundSignal({
    enabled: Boolean(url),
    onForeground: reconnectForForeground,
    isConnectionLive: () =>
      wsRef.current?.readyState === WebSocket.OPEN ||
      wsRef.current?.readyState === WebSocket.CONNECTING,
  });

  // eslint-disable-next-line no-restricted-syntax -- non-listener cleanup (clear foreground retry timers on url change/unmount)
  useEffect(() => () => clearForegroundRetryTimers(), [url, clearForegroundRetryTimers]);

  const drainMessages = useCallback((): MessageEvent[] => {
    const msgs = messageQueueRef.current;
    messageQueueRef.current = [];
    return msgs;
  }, []);

  const effectiveStatus: WsStatus =
    openedUrlRef.current === url ? status : url ? "connecting" : "closed";

  return { send, lastMessage, drainMessages, status: effectiveStatus, reconnectAttempt, reconnect };
}
