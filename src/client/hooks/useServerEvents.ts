// eslint-disable-next-line no-restricted-imports -- useEffect: EventSource (SSE) connection lifecycle with cleanup (external system sync)
import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "../stores/session-store.js";
import { useRepoStore } from "../stores/repo-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { usePrStore } from "../stores/pr-store.js";
import { fullResetAllStores } from "../stores/actions/session-actions.js";
import type { SessionInfo, RepoInfo, PrStatusSummary, DockerMemoryStats } from "../../server/shared/types.js";

/**
 * SSE hook for global push events — session list, repo updates, auth, activity dots.
 * Always active (home page and session page). Replaces WS broadcasts for global state.
 *
 * Mobile resilience: when the tab is backgrounded (user switches apps), the OS
 * often silently terminates the underlying TCP connection. Native EventSource
 * keeps `readyState === OPEN` and never fires `error`, so its built-in
 * auto-reconnect never triggers and PR/CI status updates stop arriving — the
 * UI shows stale data until the user reloads the page. We watch
 * `visibilitychange` and force a fresh connection when the tab returns to the
 * foreground; the server re-sends its snapshot (PR statuses, sessions, repos
 * — see `/api/events` initial-state writes) so the UI catches up immediately.
 */
export function useServerEvents(): void {
  const eventSourceRef = useRef<EventSource | null>(null);
  const [connectAttempt, setConnectAttempt] = useState(0);

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    const apiHost = import.meta.env.VITE_API_HOST as string | undefined;
    const baseUrl = apiHost ? `${window.location.protocol}//${apiHost}` : "";
    const es = new EventSource(`${baseUrl}/api/events`);
    eventSourceRef.current = es;

    es.addEventListener("session_list", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as { sessions: SessionInfo[] };
      useSessionStore.getState().setSessions(data.sessions);
    });

    es.addEventListener("session_started", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as { session: SessionInfo };
      useSessionStore.getState().setSessions((prev) => {
        const exists = prev.some((s) => s.id === data.session.id);
        if (exists) return prev.map((s) => s.id === data.session.id ? data.session : s);
        return [data.session, ...prev];
      });
    });

    es.addEventListener("session_renamed", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as { session: SessionInfo };
      useSessionStore.getState().setSessions((prev) =>
        prev.map((s) => s.id === data.session.id ? data.session : s),
      );
    });

    es.addEventListener("session_agent_started", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as { sessionId: string };
      useSessionStore.getState().setActiveRunnerSessions((prev) => {
        const next = new Set(prev);
        next.add(data.sessionId);
        return next;
      });
    });

    es.addEventListener("session_agent_finished", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as { sessionId: string };
      const store = useSessionStore.getState();
      store.setActiveRunnerSessions((prev) => {
        const next = new Set(prev);
        next.delete(data.sessionId);
        return next;
      });
      // Clear loading state for system-initiated turns. For user-initiated turns
      // this is already cleared by agent_result/agent_interrupted WS events.
      if (data.sessionId === store.sessionId) {
        store.setIsLoading(false);
        store.setActivity(undefined);
      }
    });

    es.addEventListener("active_runners", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as { sessionIds: string[] };
      useSessionStore.getState().setActiveRunnerSessions(() => new Set(data.sessionIds));
    });

    es.addEventListener("repo_list", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as { repos: RepoInfo[] };
      useRepoStore.getState().setRepos(data.repos);
    });

    es.addEventListener("repo_status", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as { url: string; status: "cloning" | "ready" };
      useRepoStore.getState().updateRepoStatus(data.url, data.status);
    });

    es.addEventListener("repo_warm_ready", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as { url: string; sessionId: string };
      useRepoStore.getState().updateRepoWarmSession(data.url, data.sessionId);
    });

    es.addEventListener("auth_required", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as { url?: string };
      useSessionStore.getState().setAuthUrl(data.url ?? null);
    });

    es.addEventListener("auth_complete", () => {
      useSessionStore.getState().setAuthUrl(null);
    });

    es.addEventListener("agent_list", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as { agents: { id: string; name: string; installed: boolean; authConfigured: boolean; models?: string[] }[] };
      useUiStore.getState().setAgentList(data.agents.map((a) => ({ ...a, models: a.models ?? [] })));
    });

    es.addEventListener("pr_status", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as {
        updates: PrStatusSummary[];
        removals?: string[];
      };
      usePrStore.getState().applyPrStatusUpdates(data.updates, data.removals);
    });

    es.addEventListener("docker_memory", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as DockerMemoryStats;
      useUiStore.getState().setDockerMemory(data);
    });

    /**
     * Idle / pressure cleanup notice. The orchestrator emits this when
     * `createIdleEnforcer` reaps a session container, with a `reason` field
     * the user-facing strings are derived from. Without this handler, the
     * disposal is silent on the client and the user sees their container
     * just disappear (`containerState: missing`) without explanation.
     * See docs/124-session-rescue-and-diagnostics §1.6.
     */
    es.addEventListener("session_status", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as {
        sessionId: string;
        running?: boolean;
        reason?: "idle-disposed" | "memory-pressure";
        idleMs?: number;
      };
      // Drop the disposed session from the active-runners set so any
      // running indicator clears.
      useSessionStore.getState().setActiveRunnerSessions((prev) => {
        if (!prev.has(data.sessionId)) return prev;
        const next = new Set(prev);
        next.delete(data.sessionId);
        return next;
      });
    });

    es.addEventListener("full_reset_complete", () => {
      fullResetAllStores();
      // Hard navigate home — all server state is wiped, a clean page load
      // ensures no stale in-memory state lingers (WS connections, refs, etc.)
      if (window.location.pathname !== "/") {
        window.location.href = "/";
      }
    });

    // Native EventSource "error" fires on connection drop — no data to parse.
    // Custom server-sent "server_error" events carry a JSON payload.
    es.addEventListener("server_error", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data as string) as { message: string };
        console.error("[sse] Server error:", data.message);
      } catch {
        // Malformed data — ignore
      }
    });

    es.onerror = () => {
      // Connection lost — EventSource auto-reconnects.
      // Only log if the connection was previously open.
      if (es.readyState === EventSource.CLOSED) {
        console.warn("[sse] Connection closed");
      }
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [connectAttempt]);

  // Force a fresh SSE connection when the tab returns from the background.
  // Native EventSource readyState often stays OPEN over a dead socket on
  // mobile, so we tear down and re-open instead of waiting for a (never-firing)
  // error event. Closing the previous EventSource is handled by the effect's
  // cleanup, which re-runs when `connectAttempt` changes.
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    function handleVisibilityChange() {
      if (!document.hidden) {
        setConnectAttempt((n) => n + 1);
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);
}
