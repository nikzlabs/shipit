import { useEffect, useRef } from "react";
import { useSessionStore } from "../stores/session-store.js";
import { useRepoStore } from "../stores/repo-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { usePrStore } from "../stores/pr-store.js";
import { fullResetAllStores } from "../stores/actions/session-actions.js";
import type { SessionInfo, RepoInfo, PrStatusSummary } from "../../server/shared/types.js";

/**
 * SSE hook for global push events — session list, repo updates, auth, activity dots.
 * Always active (home page and session page). Replaces WS broadcasts for global state.
 */
export function useServerEvents(): void {
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const apiHost = import.meta.env.VITE_API_HOST;
    const baseUrl = apiHost ? `${window.location.protocol}//${apiHost}` : "";
    const es = new EventSource(`${baseUrl}/api/events`);
    eventSourceRef.current = es;

    es.addEventListener("session_list", (e: MessageEvent) => {
      const data = JSON.parse(e.data) as { sessions: SessionInfo[] };
      useSessionStore.getState().setSessions(data.sessions);
    });

    es.addEventListener("session_started", (e: MessageEvent) => {
      const data = JSON.parse(e.data) as { session: SessionInfo };
      useSessionStore.getState().setSessions((prev) => {
        const exists = prev.some((s) => s.id === data.session.id);
        if (exists) return prev.map((s) => s.id === data.session.id ? data.session : s);
        return [data.session, ...prev];
      });
    });

    es.addEventListener("session_renamed", (e: MessageEvent) => {
      const data = JSON.parse(e.data) as { session: SessionInfo };
      useSessionStore.getState().setSessions((prev) =>
        prev.map((s) => s.id === data.session.id ? data.session : s),
      );
    });

    es.addEventListener("session_agent_started", (e: MessageEvent) => {
      const data = JSON.parse(e.data) as { sessionId: string };
      useSessionStore.getState().setActiveRunnerSessions((prev) => {
        const next = new Set(prev);
        next.add(data.sessionId);
        return next;
      });
    });

    es.addEventListener("session_agent_finished", (e: MessageEvent) => {
      const data = JSON.parse(e.data) as { sessionId: string };
      useSessionStore.getState().setActiveRunnerSessions((prev) => {
        const next = new Set(prev);
        next.delete(data.sessionId);
        return next;
      });
    });

    es.addEventListener("active_runners", (e: MessageEvent) => {
      const data = JSON.parse(e.data) as { sessionIds: string[] };
      useSessionStore.getState().setActiveRunnerSessions(() => new Set(data.sessionIds));
    });

    es.addEventListener("repo_list", (e: MessageEvent) => {
      const data = JSON.parse(e.data) as { repos: RepoInfo[] };
      useRepoStore.getState().setRepos(data.repos);
    });

    es.addEventListener("repo_status", (e: MessageEvent) => {
      const data = JSON.parse(e.data) as { url: string; status: "cloning" | "ready" };
      useRepoStore.getState().updateRepoStatus(data.url, data.status);
    });

    es.addEventListener("repo_warm_ready", (e: MessageEvent) => {
      const data = JSON.parse(e.data) as { url: string; sessionId: string };
      useRepoStore.getState().updateRepoWarmSession(data.url, data.sessionId);
    });

    es.addEventListener("auth_required", (e: MessageEvent) => {
      const data = JSON.parse(e.data) as { url?: string };
      useSessionStore.getState().setAuthUrl(data.url ?? null);
    });

    es.addEventListener("auth_complete", () => {
      useSessionStore.getState().setAuthUrl(null);
    });

    es.addEventListener("agent_list", (e: MessageEvent) => {
      const data = JSON.parse(e.data) as { agents: Array<{ id: string; name: string; installed: boolean; authConfigured: boolean; models?: string[] }> };
      useUiStore.getState().setAgentList(data.agents.map((a) => ({ ...a, models: a.models ?? [] })));
    });

    es.addEventListener("pr_status", (e: MessageEvent) => {
      const data = JSON.parse(e.data) as { updates: PrStatusSummary[] };
      usePrStore.getState().applyPrStatusUpdates(data.updates);
    });

    es.addEventListener("full_reset_complete", () => {
      fullResetAllStores();
    });

    // Native EventSource "error" fires on connection drop — no data to parse.
    // Custom server-sent "server_error" events carry a JSON payload.
    es.addEventListener("server_error", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { message: string };
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
  }, []);
}
