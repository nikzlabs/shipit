import { useMemo } from "react";
import { useWebSocket, type UseWebSocketReturn } from "./useWebSocket.js";
import { getSavedModelId, getSavedModelSelection, getSavedReasoning } from "../utils/local-storage.js";
import { newSessionAgentId } from "../utils/new-session-agent.js";
import { useUiStore } from "../stores/ui-store.js";

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
    const model = getSavedModelId();
    // The rule lives in `newSessionAgentId` so the composer's harness selector
    // displays exactly what this connect creates the session with.
    const agent = newSessionAgentId(useUiStore.getState().agentList);
    const params = new URLSearchParams({ agent });
    if (model) params.set("model", model);
    // docs/252 — the seed's service and billing mode ride ALONGSIDE the model id
    // rather than inside it, so the agent↔model reconciliation on the server is
    // untouched. They only bias which catalogue row the seeded id is persisted
    // as, which is the ambiguity a bare id cannot resolve once two services
    // offer the same string.
    const selection = getSavedModelSelection();
    if (selection && selection.modelId === model) {
      params.set("service", selection.serviceId);
      params.set("billingMode", selection.billingMode);
    }
    // docs/217 — seed the per-session reasoning effort from this agent's saved
    // composer pick so a brand-new session's first turn actually runs with the
    // value the selector displays (the server validates + applies it only when
    // the session is unpinned and has no persisted value).
    const reasoning = getSavedReasoning(agent);
    if (reasoning) params.set("reasoning", reasoning);
    return `${proto}//${host}/ws/sessions/${sessionId}?${params.toString()}`;
  }, [sessionId]);

  return useWebSocket(url);
}
