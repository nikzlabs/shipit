// eslint-disable-next-line no-restricted-imports -- useEffect: HTTP bootstrap fetch on mount, WS connect/disconnect handling (external system sync)
import { useEffect, useRef } from "react";
import type { WsClientMessage } from "../../server/shared/types.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { loadBootstrapData, loadSessionHistory } from "../utils/session-data.js";
import { useEventListeners } from "./useEventListener.js";

export function useConnectionSync(params: {
  status: string;
  send: (msg: WsClientMessage) => void;
  onSessionConnect?: (sessionId: string) => void | Promise<void>;
}): void {
  const { status, send, onSessionConnect } = params;

  const historyLoadedRef = useRef(false);
  const bootstrapFetchedRef = useRef(false);
  const recentlyForegroundedRef = useRef(false);
  const foregroundTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mobile app switches commonly produce transient WS closes. Give the
  // reconnect/replay path a short window before treating a streaming close as
  // a real agent error. Touches refs only, so the per-render closure is safe to
  // hand to the listener hook (it reads the latest one at fire time).
  function markRecentlyForegrounded() {
    if (document.hidden) return;
    recentlyForegroundedRef.current = true;
    if (foregroundTimerRef.current) clearTimeout(foregroundTimerRef.current);
    foregroundTimerRef.current = setTimeout(() => {
      recentlyForegroundedRef.current = false;
      foregroundTimerRef.current = null;
    }, 8000);
  }

  useEventListeners([
    { target: document, type: "visibilitychange", handler: markRecentlyForegrounded },
    { target: window, type: "pageshow", handler: markRecentlyForegrounded },
    { target: window, type: "focus", handler: markRecentlyForegrounded },
  ]);

  // The foreground timer used to be cleared in the listener effect's cleanup;
  // useEventListeners only owns the add/remove pairs, so preserve that teardown
  // here so a pending timeout doesn't fire after unmount.
  // eslint-disable-next-line no-restricted-syntax -- non-listener cleanup (clear a pending timeout on unmount)
  useEffect(() => () => {
    if (foregroundTimerRef.current) clearTimeout(foregroundTimerRef.current);
  }, []);

  // Fetch bootstrap data via HTTP — fires once on mount
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (bootstrapFetchedRef.current) return;
    bootstrapFetchedRef.current = true;

    loadBootstrapData().catch((err: unknown) => {
      console.error("[bootstrap] Failed to fetch initial data:", err);
      useUiStore.getState().setBootstrapLoaded(true);
    });
  }, []);

  // On per-session WS connect, fetch session history + send any pending message
  // (No activate_session needed — the per-session WS auto-activates via URL)
  // (No set_agent needed — passed as query param on WS URL)
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (status === "open" && !historyLoadedRef.current && useSessionStore.getState().sessionId) {
      historyLoadedRef.current = true;
      const sessionId = useSessionStore.getState().sessionId!;
      // Sync the UI's active agent to whichever provider the session is
      // actually persisted with — otherwise the localStorage default (used
      // to seed the WS URL) would mislabel a session whose server-side
      // agentId was locked in to something else.
      const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
      if (session?.agentId && session.agentId !== useUiStore.getState().activeAgentId) {
        useUiStore.getState().setActiveAgentId(session.agentId);
      }
      void (async () => {
        try {
          await loadSessionHistory(sessionId);
          await onSessionConnect?.(sessionId);
        } catch (err) {
          console.error("[api] Failed to load session history:", err);
        }
      })();

      // If there's a pending WS message (e.g. new session from home page, feature start), send it now
      const pending = useSessionStore.getState().pendingWsMessage;
      if (pending) {
        useSessionStore.getState().setPendingWsMessage(undefined);
        send({ ...pending, sessionId } as WsClientMessage);
      }
    }
    if (status === "closed" || status === "connecting") {
      historyLoadedRef.current = false;
      // Reset the store flag so the useMessageHandler guard blocks agent events
      // until the next loadSessionHistory completes. Without this, a reconnecting
      // WS would process live events before HTTP history is loaded, causing
      // duplicated or lost messages.
      useSessionStore.getState().setHistoryLoaded(false);
      // docs/178 — clear the transient "Compacting…" indicator on disconnect.
      // It's emit-only (never persisted), driven live by `compaction_status`.
      // A turn that ended while we were disconnected — or whose live
      // `running:false` we missed because the container died mid-reconnect —
      // would otherwise leave the spinner stuck on: the cleanly-ended turn's
      // event buffer is already cleared, so nothing on reconnect clears the
      // flag. Resetting here (strictly before any reconnect buffer replay) lets
      // a genuinely in-flight compaction re-establish it via the replayed
      // `compaction_status active:true`, while an ended turn stays cleared.
      useSessionStore.getState().setCompacting(false);
    }
  }, [status, send]);

  // PR status is now delivered via SSE (pr_status event) — no HTTP polling needed.

  // Handle WebSocket disconnection during streaming
  const prevStatusRef = useRef(status);
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    const wasOpen = prevStatusRef.current === "open";
    prevStatusRef.current = status;

    if (wasOpen && status === "closed" && useSessionStore.getState().isLoading) {
      if (document.hidden || recentlyForegroundedRef.current) {
        return;
      }
      // Don't inject "connection lost" when switching sessions — the stores
      // are reset and the new session will load its own state via HTTP.
      // Only show the error for genuine disconnects (messages still present).
      const session = useSessionStore.getState();
      if (session.messages.length === 0) return;

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
