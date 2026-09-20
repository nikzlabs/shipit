// eslint-disable-next-line no-restricted-imports -- useEffect: WebSocket connection lifecycle with cleanup and reconnection (external system sync)
import { useRef, useEffect, useCallback, useState } from "react";
import { useForegroundSignal, type ForegroundResume } from "./useForegroundSignal.js";
import { randomId } from "../utils/random-id.js";

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

/**
 * How long the page may have been away and still have its socket kept (docs/311
 * req 3). Past this the socket is replaced without asking, which is cheaper
 * than probing and then replacing it anyway.
 */
export const KEEP_SOCKET_MAX_AWAY_MS = 60_000;

/** How long a liveness probe waits for any byte before calling the socket dead. */
export const PROBE_TIMEOUT_MS = 2000;

/**
 * How long a handshake may be in flight before a foreground retry may tear it
 * down (docs/311 req 6). A cellular handshake routinely outlives the old 300 ms
 * retry, which restarted the connection it was waiting for.
 */
export const STALLED_HANDSHAKE_MS = 3000;

/** Only for a handshake that never completes and never fires `close`; backoff owns the rest. */
const FOREGROUND_RETRY_DELAYS_MS = [3000, 9000];

type ProbeOutcome = "alive" | "dead" | "abandoned";

/** Transport bookkeeping, so it is consumed here rather than dispatched. */
function isPongFrame(data: unknown): boolean {
  if (typeof data !== "string" || data.length > 128) return false;
  try {
    return (JSON.parse(data) as { type?: unknown }).type === "pong";
  } catch {
    return false;
  }
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
  const connectStartedAtRef = useRef(0);
  const probeRef = useRef<{
    id: string;
    settle: (outcome: ProbeOutcome) => void;
    promise: Promise<ProbeOutcome>;
  } | null>(null);

  const settleProbe = useCallback((outcome: ProbeOutcome) => {
    const probe = probeRef.current;
    if (!probe) return;
    probeRef.current = null;
    probe.settle(outcome);
  }, []);

  /**
   * Ask the socket whether it is still there (docs/311 req 5).
   *
   * `readyState` cannot answer: a mobile OS kills a backgrounded connection
   * without telling the JS layer, leaving it `OPEN` forever. Nor can a protocol
   * ping — those are server-initiated and answered beneath JS — so the question
   * is an application frame, and *any* inbound byte is the answer. The server's
   * `pong` exists only so a server with nothing else to say still produces one.
   */
  const probeSocket = useCallback((): Promise<ProbeOutcome> => {
    const existing = probeRef.current;
    if (existing) return existing.promise;

    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return Promise.resolve<ProbeOutcome>("dead");

    const id = randomId();
    let resolve!: (outcome: ProbeOutcome) => void;
    const promise = new Promise<ProbeOutcome>((r) => { resolve = r; });
    const timer = setTimeout(() => settleProbe("dead"), PROBE_TIMEOUT_MS);
    probeRef.current = {
      id,
      settle: (outcome) => { clearTimeout(timer); resolve(outcome); },
      promise,
    };

    try {
      ws.send(JSON.stringify({ type: "ping", id }));
    } catch {
      settleProbe("dead");
    }
    return promise;
  }, [settleProbe]);

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
    connectStartedAtRef.current = Date.now();
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
      // Bytes arriving prove the path works, whatever they say.
      settleProbe("alive");
      if (isPongFrame(event.data)) return;
      messageQueueRef.current.push(event);
      setLastMessage(event);
    };

    return () => {
      intentionalClose = true;
      // The socket this probe was asking about is gone; its answer decides nothing.
      settleProbe("abandoned");
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
  }, [url, connectAttempt, clearForegroundRetryTimers, settleProbe]);

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

  /**
   * A handshake young enough that replacing it would only restart it. The
   * foreground retries exist for a socket stuck in `CONNECTING` forever with no
   * `close` — a radio that never finished waking — and that is the only thing
   * they may act on (docs/311 req 6).
   */
  const handshakeIsYoung = useCallback(
    () =>
      wsRef.current?.readyState === WebSocket.CONNECTING
      && Date.now() - connectStartedAtRef.current < STALLED_HANDSHAKE_MS,
    [],
  );

  const forceFreshSocket = useCallback(() => {
    clearForegroundRetryTimers();
    if (!handshakeIsYoung()) openFreshSocket();
    for (const delay of FOREGROUND_RETRY_DELAYS_MS) {
      const timer = setTimeout(() => {
        if (document.hidden) return;
        if (wsRef.current?.readyState === WebSocket.OPEN) return;
        if (handshakeIsYoung()) return;
        openFreshSocket();
      }, delay);
      foregroundRetryTimersRef.current.push(timer);
    }
  }, [clearForegroundRetryTimers, handshakeIsYoung, openFreshSocket]);

  /**
   * Returning to the app used to replace the socket every time, however brief
   * the switch away — which is what put a "Reconnecting" banner on an alt-tab
   * and left a returning mobile user unable to send (docs/311 req 1, req 2).
   *
   * A socket the page was only briefly away from is kept if it can prove it is
   * alive, and replaced if it cannot. Keeping it leaves `status` at `open`
   * throughout, so there is no banner, no history refetch and no attach burst.
   */
  const reconnectForForeground = useCallback(({ awayMs }: ForegroundResume) => {
    clearForegroundRetryTimers();
    settleProbe("abandoned");

    const keepable =
      wsRef.current?.readyState === WebSocket.OPEN
      && (awayMs === undefined || awayMs < KEEP_SOCKET_MAX_AWAY_MS);
    if (!keepable) {
      forceFreshSocket();
      return;
    }

    void probeSocket().then((outcome) => {
      // Away again before the answer arrived: the next resume asks afresh.
      if (outcome === "dead" && !document.hidden) forceFreshSocket();
    });
  }, [clearForegroundRetryTimers, forceFreshSocket, probeSocket, settleProbe]);

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
