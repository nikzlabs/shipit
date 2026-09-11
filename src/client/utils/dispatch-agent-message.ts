

import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { randomId } from "./random-id.js";
import type { ApiError } from "../hooks/useApi.js";
import type { AgentInterfaceProvenance } from "../../server/shared/agent-interface-sdk/protocol.js";

export interface DispatchAgentMessageOptions {
  sessionId: string;
  text: string;
  activity: string;
  apiPost: <T>(path: string, body?: unknown) => Promise<T>;
  agentInterface?: AgentInterfaceProvenance;
}

export async function dispatchAgentMessage(opts: DispatchAgentMessageOptions): Promise<void> {
  const { sessionId, text, activity, apiPost, agentInterface } = opts;
  const session = useSessionStore.getState();
  const requestId = randomId();

  session.setMessages((prev) => [...prev, {
    role: "user",
    text,
    pendingDispatch: true,
    clientRequestId: requestId,
    ...(agentInterface ? { agentInterface } : {}),
  }]);
  session.setIsLoading(true);
  session.setActivity({ label: activity });

  try {
    await apiPost<{ ok: true; queued: boolean }>(
      `/api/sessions/${sessionId}/agent/dispatch`,
      { text, activity, ...(agentInterface ? { agentInterface } : {}) },
    );
  } catch (err) {

    useSessionStore.getState().setMessages((prev) =>
      prev.filter((message) => message.clientRequestId !== requestId));
    useSessionStore.getState().setIsLoading(false);
    useSessionStore.getState().setActivity(undefined);

    const message = err instanceof Error ? err.message : "Failed to send to agent";
    useUiStore.getState().setToast({ message });
    throw err;
  }
}

export type { ApiError };
