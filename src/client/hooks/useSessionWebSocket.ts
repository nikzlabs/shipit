import { useMemo } from "react";
import { useWebSocket, type UseWebSocketReturn } from "./useWebSocket.js";
import { getSavedAgentId, getSavedModelId, getSavedReasoning } from "../utils/local-storage.js";
import { agentIdForModel } from "../utils/agent-for-model.js";
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
    // The model is the single source of truth; derive the agent from it so a
    // stale `vibe-agent-id` can't override the user's model pick (the server
    // would otherwise treat the agent as authoritative and rewrite the model —
    // e.g. opus → gpt-5.5). Fall back to the saved agent only when the model is
    // unknown or the agent list hasn't loaded yet. See docs/142 (Problem C).
    const agent =
      agentIdForModel(model, useUiStore.getState().agentList) ?? getSavedAgentId();
    const params = new URLSearchParams({ agent });
    if (model) params.set("model", model);
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
