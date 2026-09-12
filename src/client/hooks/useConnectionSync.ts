// eslint-disable-next-line no-restricted-imports -- useEffect: HTTP bootstrap fetch on mount, WS connect/disconnect handling (external system sync)
import { useEffect, useRef, useState } from "react";
import type { WsClientMessage } from "../../server/shared/types.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { loadBootstrapData, loadSessionHistory } from "../utils/session-data.js";
import { useForegroundSignal } from "./useForegroundSignal.js";

export function useConnectionSync(params: {
  status: string;

  send: (msg: WsClientMessage) => boolean;
  onSessionConnect?: (sessionId: string) => void | Promise<void>;
}): void {
  const { status, send, onSessionConnect } = params;

  const historyLoaded = useSessionStore((s) => s.historyLoaded);

  /**
   * A history load is on the wire right now. This is re-entrancy protection
   * only — "does the transcript have its baseline" is answered by the store's
   * `historyLoaded`, never by a hook-local latch.
   *
   * It used to be that latch ("a load has been issued for this connection"),
   * cleared only on a `closed`/`connecting` status transition. That made the
   * store flag and the hook disagree about the same fact: any path that
   * lowered the flag without changing the socket — `resumeSessionInternal`
   * resuming the session already on screen, which "All Sessions" does because
   * it renders every row as non-current — found the latch still raised, so no
   * load was ever issued and `useMessageHandler` queued the transcript
   * forever.
   */
  const historyLoadInFlightRef = useRef(false);
  /**
   * Identifies the newest hydration attempt. A load that is no longer the
   * newest — superseded by a reconnect, or abandoned by a disconnect — must not
   * clear the guard, nudge the effect, or run `onSessionConnect`, because it is
   * speaking for a socket generation that is gone.
   */
  const hydrateGenerationRef = useRef(0);

  const [hydrateAttempt, setHydrateAttempt] = useState(0);
  const bootstrapFetchedRef = useRef(false);
  const recentlyForegroundedRef = useRef(false);
  const foregroundTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function markRecentlyForegrounded() {
    recentlyForegroundedRef.current = true;
    if (foregroundTimerRef.current) clearTimeout(foregroundTimerRef.current);
    foregroundTimerRef.current = setTimeout(() => {
      recentlyForegroundedRef.current = false;
      foregroundTimerRef.current = null;
    }, 8000);
  }

  useForegroundSignal({
    onForeground: markRecentlyForegrounded,

    isConnectionLive: () => status === "open",
  });

  // eslint-disable-next-line no-restricted-syntax -- non-listener cleanup (clear a pending timeout on unmount)
  useEffect(() => () => {
    if (foregroundTimerRef.current) clearTimeout(foregroundTimerRef.current);
  }, []);

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (bootstrapFetchedRef.current) return;
    bootstrapFetchedRef.current = true;

    loadBootstrapData().catch((err: unknown) => {
      console.error("[bootstrap] Failed to fetch initial data:", err);
      useUiStore.getState().setBootstrapLoaded(true);
    });
  }, []);

  // eslint-disable-next-line no-restricted-syntax -- existing usage; see above
  useEffect(() => {
    if (status === "open" && !historyLoaded && !historyLoadInFlightRef.current && useSessionStore.getState().sessionId) {
      historyLoadInFlightRef.current = true;
      const attempt = ++hydrateGenerationRef.current;
      const sessionId = useSessionStore.getState().sessionId!;

      const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
      if (session?.agentId && session.agentId !== useUiStore.getState().activeAgentId) {
        useUiStore.getState().setActiveAgentId(session.agentId);
      }
      void (async () => {
        let loaded = false;
        try {
          await loadSessionHistory(sessionId);
          loaded = true;

          if (hydrateGenerationRef.current !== attempt) return;
          await onSessionConnect?.(sessionId);
        } catch (err) {
          console.error("[api] Failed to load session history:", err);
        } finally {

          if (hydrateGenerationRef.current === attempt) {
            historyLoadInFlightRef.current = false;

            // raised. Clearing a ref renders nothing, so the effect would never

            if (loaded && !useSessionStore.getState().historyLoaded) {
              setHydrateAttempt((n) => n + 1);
            }
          }
        }
      })();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `onSessionConnect` is re-created each render (see above)
  }, [status, historyLoaded, hydrateAttempt, send]);

  // eslint-disable-next-line no-restricted-syntax -- existing usage; status-transition-keyed
  useEffect(() => {
    if (status !== "open") return;
    const sessionId = useSessionStore.getState().sessionId;
    const pending = useSessionStore.getState().pendingWsMessage;
    if (!sessionId || !pending) return;

    if (send({ ...pending, sessionId } as WsClientMessage)) {
      useSessionStore.getState().setPendingWsMessage(undefined);
    }
  }, [status, send]);

  // cannot survive the gap. Keyed on `status` alone so it fires once per

  // eslint-disable-next-line no-restricted-syntax -- existing usage; status-transition-keyed, see above
  useEffect(() => {
    if (status === "closed" || status === "connecting") {

      // next open must be free to issue its own rather than wait on a request

      hydrateGenerationRef.current += 1;
      historyLoadInFlightRef.current = false;

      useSessionStore.getState().setHistoryLoaded(false);

      // It's emit-only (never persisted), driven live by `compaction_status`.

      // `running:false` we missed because the container died mid-reconnect —

      useSessionStore.getState().setCompacting(false);

      useSessionStore.setState({ subAgentSpawns: {} });
    }
  }, [status]);

  const prevStatusRef = useRef(status);
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    const wasOpen = prevStatusRef.current === "open";
    prevStatusRef.current = status;

    if (wasOpen && status === "closed" && useSessionStore.getState().isLoading) {
      if (document.hidden || recentlyForegroundedRef.current) {
        return;
      }

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
