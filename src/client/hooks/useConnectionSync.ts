import { useEffect, useRef } from "react";
import type { WsClientMessage } from "../../server/shared/types.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { loadBootstrapData, loadSessionHistory } from "../utils/session-data.js";

export function useConnectionSync(params: {
  status: string;
  send: (msg: WsClientMessage) => void;
}): void {
  const { status, send } = params;

  const historyLoadedRef = useRef(false);
  const bootstrapFetchedRef = useRef(false);

  // Fetch bootstrap data via HTTP — fires once on mount
  useEffect(() => {
    if (bootstrapFetchedRef.current) return;
    bootstrapFetchedRef.current = true;

    loadBootstrapData().catch((err) => {
      console.error("[bootstrap] Failed to fetch initial data:", err);
      useUiStore.getState().setBootstrapLoaded(true);
    });
  }, []);

  // On per-session WS connect, fetch session history + send any pending message
  // (No activate_session needed — the per-session WS auto-activates via URL)
  // (No set_agent needed — passed as query param on WS URL)
  useEffect(() => {
    if (status === "open" && !historyLoadedRef.current && useSessionStore.getState().sessionId) {
      historyLoadedRef.current = true;
      const sessionId = useSessionStore.getState().sessionId!;
      loadSessionHistory(sessionId).catch((err) => console.error("[api] Failed to load session history:", err));

      // If there's a pending WS message (e.g. new session from home page, feature start), send it now
      const pending = useSessionStore.getState().pendingWsMessage;
      if (pending) {
        useSessionStore.getState().setPendingWsMessage(undefined);
        send({ ...pending, sessionId } as import("../../server/shared/types.js").WsClientMessage);
      }
    }
    if (status === "closed") {
      historyLoadedRef.current = false;
    }
  }, [status, send]);

  // PR status is now delivered via SSE (pr_status event) — no HTTP polling needed.

  // Handle WebSocket disconnection during streaming
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const wasOpen = prevStatusRef.current === "open";
    prevStatusRef.current = status;

    if (wasOpen && status === "closed" && useSessionStore.getState().isLoading) {
      const session = useSessionStore.getState();
      session.setIsLoading(false);
      session.setActivity(undefined);
      session.setMessages((prev) => {
        const last = prev[prev.length - 1];
        const updated =
          last?.role === "assistant" && last.streaming
            ? [...prev.slice(0, -1), { ...last, streaming: false }]
            : prev;
        return [
          ...updated,
          {
            role: "assistant" as const,
            text: "Error: Connection lost while the agent was responding. Your message may be incomplete.",
            streaming: false,
            isError: true,
          },
        ];
      });
    }
  }, [status]);
}
