import { useRef, useEffect, useCallback, useState } from "react";

export type WsStatus = "connecting" | "open" | "closed";

export interface UseWebSocketReturn {
  send: (data: unknown) => void;
  lastMessage: MessageEvent | null;
  status: WsStatus;
}

export function useWebSocket(url: string): UseWebSocketReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<WsStatus>("connecting");
  const [lastMessage, setLastMessage] = useState<MessageEvent | null>(null);
  const [connectAttempt, setConnectAttempt] = useState(0);

  useEffect(() => {
    const ws = new WebSocket(url);
    wsRef.current = ws;
    setStatus("connecting");

    ws.onopen = () => setStatus("open");
    ws.onclose = () => {
      setStatus("closed");
      // Auto-reconnect after 2 seconds
      setTimeout(() => setConnectAttempt((n) => n + 1), 2000);
    };
    ws.onmessage = (event) => setLastMessage(event);

    return () => {
      ws.close();
    };
  }, [url, connectAttempt]);

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  return { send, lastMessage, status };
}
