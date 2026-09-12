

import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { randomId } from "./random-id.js";
import type { ApiError } from "../hooks/useApi.js";
import type { AgentInterfaceProvenance } from "../../server/shared/agent-interface-sdk/protocol.js";
import { consumeMergeContinueIntent, mergeContinueFrameFields } from "./merge-continue-intent.js";

export interface DispatchAgentMessageOptions {
  sessionId: string;
  text: string;
  activity: string;
  apiPost: <T>(path: string, body?: unknown) => Promise<T>;
  agentInterface?: AgentInterfaceProvenance;
  /**
   * docs/218 + docs/295 — the user clicked the thing that sent this, in the
   * view the post-merge checkboxes are in, so it carries their untick and
   * spends it (req 5). The distinction that matters is the INTERACTION, not
   * the transport: a ShipIt button that POSTs must behave like one that opens
   * a WebSocket frame.
   *
   * Left off for a continuation the user did not make — a CI auto-fix, a click
   * inside an agent-built page — which follows the global setting (req 13).
   */
  userInitiated?: boolean;
}

export async function dispatchAgentMessage(opts: DispatchAgentMessageOptions): Promise<void> {
  const { sessionId, text, activity, apiPost, agentInterface, userInitiated } = opts;
  const intent = userInitiated ? mergeContinueFrameFields(sessionId) : {};
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
      { text, activity, ...(agentInterface ? { agentInterface } : {}), ...intent },
    );
    // Only a dispatch the server accepted spends the untick.
    if (userInitiated) consumeMergeContinueIntent(sessionId);
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
