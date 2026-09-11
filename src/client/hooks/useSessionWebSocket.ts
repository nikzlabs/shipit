import { useMemo } from "react";
import { useWebSocket, type UseWebSocketReturn } from "./useWebSocket.js";
import { getSavedModelId, getSavedModelSelection, getSavedReasoning, getSavedRoleName } from "../utils/local-storage.js";
import { newSessionAgentId } from "../utils/new-session-agent.js";
import { useUiStore } from "../stores/ui-store.js";

export function useSessionWebSocket(sessionId: string | undefined): UseWebSocketReturn {
  const url = useMemo(() => {
    if (!sessionId) return null;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = (import.meta.env.VITE_API_HOST as string | undefined) || window.location.host;
    const model = getSavedModelId();

    const agent = newSessionAgentId(useUiStore.getState().agentList);
    const params = new URLSearchParams({ agent });
    if (model) params.set("model", model);

    // as, which is the ambiguity a bare id cannot resolve once two services

    const selection = getSavedModelSelection();
    if (selection && selection.modelId === model) {
      params.set("service", selection.serviceId);
      params.set("billingMode", selection.billingMode);
    }

    const reasoning = getSavedReasoning(agent);
    if (reasoning) params.set("reasoning", reasoning);

    const role = getSavedRoleName();
    if (role) params.set("role", role);
    return `${proto}//${host}/ws/sessions/${sessionId}?${params.toString()}`;
  }, [sessionId]);

  return useWebSocket(url);
}
