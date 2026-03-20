import { useMemo } from "react";
import { useWebSocket, type UseWebSocketReturn } from "./useWebSocket.js";
import { getSavedAgentId, getSavedModelId } from "../utils/local-storage.js";

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
    const host = (import.meta.env.VITE_API_HOST as string | undefined) || window.location.host;
    const agent = getSavedAgentId();
    const model = getSavedModelId();
    const params = new URLSearchParams({ agent });
    if (model) params.set("model", model);
    return `${proto}//${host}/ws/sessions/${sessionId}?${params.toString()}`;
  }, [sessionId]);

  return useWebSocket(url);
}
