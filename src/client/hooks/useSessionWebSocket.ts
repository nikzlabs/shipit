import { useMemo } from "react";
import { useWebSocket, type UseWebSocketReturn } from "./useWebSocket.js";
import { getSavedAgentId } from "../utils/local-storage.js";

/**
 * Per-session WebSocket hook.
 *
 * When sessionId is defined → connects to `/ws/sessions/{id}?agent={saved}`.
 * When sessionId is undefined → no connection (returns closed/noop state).
 */
export function useSessionWebSocket(sessionId: string | undefined): UseWebSocketReturn {
  const url = useMemo(() => {
    if (!sessionId) return null;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = import.meta.env.VITE_API_HOST || window.location.host;
    const agent = getSavedAgentId();
    return `${proto}//${host}/ws/sessions/${sessionId}?agent=${agent}`;
  }, [sessionId]);

  return useWebSocket(url);
}
