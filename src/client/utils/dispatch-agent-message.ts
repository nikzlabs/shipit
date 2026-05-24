/**
 * Client helper for POST /api/sessions/:id/agent/dispatch (docs/150).
 *
 * Mirrors the optimistic-append pattern that WS `send_message` callsites already
 * use: append a synthetic user bubble (tagged `pendingDispatch: true` so the
 * `system_user_message` handler can dedupe by clearing the flag in place
 * instead of appending a duplicate), set the loading/activity state, then POST.
 *
 * On error, rolls back the optimistic bubble and surfaces a toast via the UI
 * store. The 401 case is the most common deliberate failure (the active agent
 * isn't authenticated); the toast routes through the standard error channel.
 */

import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import type { ApiError } from "../hooks/useApi.js";

export interface DispatchAgentMessageOptions {
  sessionId: string;
  text: string;
  activity: string;
  apiPost: <T>(path: string, body?: unknown) => Promise<T>;
}

export async function dispatchAgentMessage(opts: DispatchAgentMessageOptions): Promise<void> {
  const { sessionId, text, activity, apiPost } = opts;
  const session = useSessionStore.getState();

  // Optimistic append — the server's `system_user_message` echo is deduped
  // against this bubble via the `pendingDispatch` flag.
  session.setMessages((prev) => [...prev, { role: "user", text, pendingDispatch: true }]);
  session.setIsLoading(true);
  session.setActivity({ label: activity });

  try {
    await apiPost<{ ok: true; queued: boolean }>(
      `/api/sessions/${sessionId}/agent/dispatch`,
      { text, activity },
    );
  } catch (err) {
    // Roll back the optimistic bubble — pop the last matching pending message.
    useSessionStore.getState().setMessages((prev) => {
      for (let i = prev.length - 1; i >= 0; i--) {
        const m = prev[i];
        if (m?.role === "user" && m.text === text && m.pendingDispatch) {
          return [...prev.slice(0, i), ...prev.slice(i + 1)];
        }
      }
      return prev;
    });
    useSessionStore.getState().setIsLoading(false);
    useSessionStore.getState().setActivity(undefined);

    const message = err instanceof Error ? err.message : "Failed to send to agent";
    useUiStore.getState().setToast({ message });
    throw err;
  }
}

/** Re-export so callers can `instanceof`-check the failure shape if needed. */
export type { ApiError };
