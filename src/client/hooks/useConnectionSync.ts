// eslint-disable-next-line no-restricted-imports -- useEffect: HTTP bootstrap fetch on mount, WS connect/disconnect handling (external system sync)
import { useEffect, useRef } from "react";
import type { WsClientMessage } from "../../server/shared/types.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { loadBootstrapData, loadSessionHistory } from "../utils/session-data.js";
import { useForegroundSignal } from "./useForegroundSignal.js";

export function useConnectionSync(params: {
  status: string;
  /** Returns whether the frame reached the wire — see `useWebSocket.send`. */
  send: (msg: WsClientMessage) => boolean;
  onSessionConnect?: (sessionId: string) => void | Promise<void>;
}): void {
  const { status, send, onSessionConnect } = params;

  // Subscribed, not read through `getState()`: lowering this flag is what
  // re-arms hydration, so the effect below has to re-run when it moves. App
  // already subscribes to it, so this adds no renders.
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
  const bootstrapFetchedRef = useRef(false);
  const recentlyForegroundedRef = useRef(false);
  const foregroundTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mobile app switches commonly produce transient WS closes. Give the
  // reconnect/replay path a short window before treating a streaming close as
  // a real agent error. Touches refs only, so the per-render closure is safe to
  // hand to the listener hook (it reads the latest one at fire time).
  //
  // This has to use the SAME genuine-resume test as the two connection hooks,
  // not its own `focus` listener. A bare `focus` is fired by the preview iframe
  // on every load, so counting it as a foregrounding kept this 8s suppression
  // window permanently open next to a live preview — and a genuine mid-stream
  // disconnect then skipped the "connection lost" message below, stranding the
  // composer in its loading state with nothing on screen to explain it.
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
    // The window this suppression protects is exactly the one where a live-
    // looking socket turns out to be dead, so an open socket is not a reason to
    // skip marking the resume.
    isConnectionLive: () => status === "open",
  });

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

  // Hydrate whenever the socket is open and the transcript has no baseline —
  // fetch session history + send any pending message.
  // (No activate_session needed — the per-session WS auto-activates via URL)
  // (No set_agent needed — passed as query param on WS URL)
  //
  // Keyed on `historyLoaded` rather than on the status transition alone, so a
  // reset performed by anything other than a disconnect (a session switch, a
  // resume of the session already on screen) re-arms hydration on its own. The
  // status transition is still what clears the flag on a disconnect, below.
  //
  // `onSessionConnect` is a caller-supplied callback that is re-created on each
  // render, so it is invoked but deliberately not depended on.
  // eslint-disable-next-line no-restricted-syntax -- existing usage; see above
  useEffect(() => {
    if (status === "open" && !historyLoaded && !historyLoadInFlightRef.current && useSessionStore.getState().sessionId) {
      historyLoadInFlightRef.current = true;
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
        } finally {
          historyLoadInFlightRef.current = false;
        }
      })();

      // If there's a pending WS message (e.g. new session from home page, feature start), send it now
      const pending = useSessionStore.getState().pendingWsMessage;
      if (pending) {
        // Only drop the stash once the frame is actually on the wire. The
        // status transition can land a tick before the socket is writable (or
        // the socket can close again in between), and clearing first would lose
        // the message with no trace — the same silent drop `send`'s boolean
        // exists to expose. Keeping it stashed means the next open retries it.
        if (send({ ...pending, sessionId } as WsClientMessage)) {
          useSessionStore.getState().setPendingWsMessage(undefined);
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `onSessionConnect` is re-created each render (see above)
  }, [status, historyLoaded, send]);

  // On disconnect, drop the transcript baseline and the live-only signals that
  // cannot survive the gap. Keyed on `status` alone so it fires once per
  // transition — not again every time `historyLoaded` moves while we are down.
  // eslint-disable-next-line no-restricted-syntax -- existing usage; status-transition-keyed, see above
  useEffect(() => {
    if (status === "closed" || status === "connecting") {
      // The load this connection issued (if any) is abandoned: its response may
      // still land — `historyLoadSeq` decides whether it may write — but the
      // next open must be free to issue its own rather than wait on a request
      // whose socket is gone.
      historyLoadInFlightRef.current = false;
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
      // A consult can finish while this browser is disconnected. Its terminal
      // card is persisted, but the completion event is then behind the replay
      // cursor, so a chip left in client memory would otherwise linger forever
      // at the transcript footer. Clear live-only chips on disconnect. A consult
      // that is genuinely still running is restored by its buffered spawn event
      // after HTTP history hydration.
      useSessionStore.setState({ subAgentSpawns: {} });
    }
  }, [status]);

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
