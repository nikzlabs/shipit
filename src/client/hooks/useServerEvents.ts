// eslint-disable-next-line no-restricted-imports -- useEffect: EventSource (SSE) connection lifecycle with cleanup (external system sync)
import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "../stores/session-store.js";
import { useRepoStore } from "../stores/repo-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { usePrStore } from "../stores/pr-store.js";
import { useReleaseStore } from "../stores/release-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import type { ToastData } from "../components/Toast.js";
import { fullResetAllStores } from "../stores/actions/session-actions.js";
import type { SessionInfo, RepoInfo, PrStatusSummary, ReleaseStatusSummary, DockerMemoryStats, SystemInfo, SubscriptionLimitsMap, PermissionMode, ProviderAccount, AgentId } from "../../server/shared/types.js";
import { getLoadedClientBuildId, shouldReloadForServerBuild } from "../utils/client-build.js";

let reloadingForClientUpdate = false;

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

    // ---- Unified per-agent auth events (docs/155 Phase 2b) ----
    // The orchestrator broadcasts one event family for every backend's
    // sign-in lifecycle: `agent_auth_pending` (sign-in card content arriving),
    // `agent_auth_complete` (success), `agent_auth_failed` (failure or
    // revocation). The legacy event names (`auth_required`, `auth_complete`,
    // `codex_auth_*`) are gone; adding a new backend is one variant added to
    // the discriminated `details.kind` union, not three new listeners here.
    // docs/155: the three SSE auth handlers below dispatch on the runtime
    // event's `agentId` + `details.kind` to route each backend's payload into
    // a different store slice (sessionStore.setAuthUrl vs
    // settingsStore.setCodexDeviceAuth*). That's discriminated-union
    // narrowing of received wire data, not abstraction-leaking dispatch —
    // adding a backend means adding one more `else if` here that targets
    // whatever store slice owns its sign-in card. The disables sit inline
    // so a new backend wires its narrowing without re-tripping the leak guard.
    es.addEventListener("agent_auth_pending", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as {
        agentId: AgentId;
        details:
          | { kind: "code-paste-url"; verificationUri: string }
          | { kind: "device-code"; verificationUri: string; userCode: string; expiresInSec: number };
      };
      // eslint-disable-next-line no-restricted-syntax -- docs/155: SSE-event narrowing, see comment above
      if (data.agentId === "claude" && data.details.kind === "code-paste-url") {
        useSessionStore.getState().setAuthUrl(data.details.verificationUri);
      // eslint-disable-next-line no-restricted-syntax -- docs/155: SSE-event narrowing, see comment above
      } else if (data.agentId === "codex" && data.details.kind === "device-code") {
        useSettingsStore.getState().setCodexDeviceAuth({
          verificationUri: data.details.verificationUri,
          userCode: data.details.userCode,
          expiresInSec: data.details.expiresInSec,
        });
        useSettingsStore.getState().setCodexDeviceAuthError(null);
      }
    });

    es.addEventListener("agent_auth_complete", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as { agentId: AgentId };
      // eslint-disable-next-line no-restricted-syntax -- docs/155: SSE-event narrowing, see comment above
      if (data.agentId === "claude") {
        useSessionStore.getState().setAuthUrl(null);
      // eslint-disable-next-line no-restricted-syntax -- docs/155: SSE-event narrowing, see comment above
      } else if (data.agentId === "codex") {
        useSettingsStore.getState().setCodexDeviceAuth(null);
        useSettingsStore.getState().setCodexDeviceAuthError(null);
      }
    });

    es.addEventListener("agent_auth_failed", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as {
        agentId: AgentId;
        reason?: "timeout" | "denied" | "error" | "revoked";
        message?: string;
      };
      // eslint-disable-next-line no-restricted-syntax -- docs/155: SSE-event narrowing, see comment above
      if (data.agentId === "claude") {
        // Clear the URL so the sign-in card flips back to "Sign in" — also
        // the path the legacy `auth_required {}` broadcast took for
        // refresher-revoked accounts.
        useSessionStore.getState().setAuthUrl(null);
      // eslint-disable-next-line no-restricted-syntax -- docs/155: SSE-event narrowing, see comment above
      } else if (data.agentId === "codex") {
        useSettingsStore.getState().setCodexDeviceAuth(null);
        const fallback = data.reason === "timeout"
          ? "Sign-in timed out. Try again."
          : data.reason === "denied"
            ? "Sign-in was denied."
            : "Sign-in failed. Try again.";
        useSettingsStore.getState().setCodexDeviceAuthError(data.message ?? fallback);
      }
    });

    // The orchestrator pushes `github_status` whenever the stored GitHub
    // token's authenticated state changes outside the normal sign-in /
    // logout HTTP routes — today that's only "token marked invalid by a
    // failed git push/fetch/pull" (see `GitHubAuthManager.markTokenInvalid`).
    // Without this listener the UI keeps believing GitHub is authenticated
    // until the user reloads, and the only signal of the expired token is
    // a line buried in the per-session Logs panel.
    es.addEventListener("github_status", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as {
        authenticated: boolean;
        username?: string;
        avatarUrl?: string;
        tokenInvalidReason?: string;
      };
      useSettingsStore.getState().setGithubStatus({
        authenticated: data.authenticated,
        ...(data.username ? { username: data.username } : {}),
        ...(data.avatarUrl ? { avatarUrl: data.avatarUrl } : {}),
      });
      if (data.tokenInvalidReason && !data.authenticated) {
        const toast: ToastData = {
          message: "Your GitHub token is invalid or expired. Sign in again to keep pushing.",
          action: {
            label: "Sign in",
            onClick: () => {
              useUiStore.getState().setSettingsTab("github");
              useUiStore.getState().setSettingsOpen(true);
            },
          },
          duration: 12000,
        };
        useUiStore.getState().setToast(toast);
      }
    });

    es.addEventListener("agent_list", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as {
        agents: {
          id: string;
          name: string;
          installed: boolean;
          authConfigured: boolean;
          models?: string[];
          // 125 — every adapter now publishes a supportsReview flag, but old
          // server builds may omit it; default to false so a stale wire
          // payload hides the AI Review affordance rather than showing it.
          supportsReview?: boolean;
          // 178 — compaction support; absent on old payloads, in which case the
          // `/compact` command entry simply won't be offered.
          supportsCompaction?: boolean;
          // 138 — permission modes the agent supports; absent on old payloads,
          // in which case the selector simply won't offer `guarded`.
          supportedPermissionModes?: PermissionMode[];
        }[];
      };
      const agents = data.agents.map((a) => ({
        ...a,
        models: a.models ?? [],
        supportsReview: a.supportsReview ?? false,
        supportsCompaction: a.supportsCompaction ?? false,
        supportedPermissionModes: a.supportedPermissionModes,
      }));
      useUiStore.getState().setAgentList(agents);
      // If the currently selected agent isn't installed-and-authed, redirect
      // the picker to the first agent that is. Avoids the home-screen picker
      // sitting on "claude" by default on a Codex-only install (the picker
      // initially hydrates from localStorage with a "claude" fallback, which
      // is wrong if Claude isn't authed).
      const activeAgentId = useUiStore.getState().activeAgentId;
      const active = agents.find((a) => a.id === activeAgentId);
      if (!active || !active.installed || !active.authConfigured) {
        const firstAuthed = agents.find((a) => a.installed && a.authConfigured);
        if (firstAuthed && firstAuthed.id !== activeAgentId) {
          useUiStore.getState().setActiveAgentId(firstAuthed.id as AgentId);
        }
      }
    });

    es.addEventListener("provider_accounts", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as { accounts: ProviderAccount[] };
      useSettingsStore.getState().setProviderAccounts(data.accounts);
    });

    es.addEventListener("pr_status", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as {
        updates: PrStatusSummary[];
        removals?: string[];
        // Initial-connect snapshot (see /api/events). When true the client
        // treats `updates` as the complete poller-derived PR set and drops
        // any stale entry it holds for a session not present — so a reconnect
        // (e.g. mobile foreground) converges to the server's current truth
        // even for PRs that merged/closed while the socket was dead.
        isSnapshot?: boolean;
      };
      usePrStore.getState().applyPrStatusUpdates(data.updates, data.removals, data.isSnapshot);
    });

    // docs/171 — release lifecycle card updates. Same snapshot/removal
    // semantics as pr_status; drives the inline ReleaseLifecycleCard.
    es.addEventListener("release_status", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as {
        updates: ReleaseStatusSummary[];
        removals?: string[];
        isSnapshot?: boolean;
      };
      useReleaseStore.getState().applyReleaseStatusUpdates(data.updates, data.removals, data.isSnapshot);
    });

    // GitHub API rate-limit state. The server pauses GraphQL polling while
    // limited and pushes these transitions; the UI surfaces a non-error
    // banner with a live countdown until `resetAt`. See
    // src/server/orchestrator/pr-status-poller.ts and github-auth.ts.
    es.addEventListener("gh_rate_limited", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as { resetAt: number | null };
      useSettingsStore.getState().setGithubRateLimit({ resetAt: data.resetAt });
    });

    es.addEventListener("gh_rate_limited_cleared", () => {
      useSettingsStore.getState().setGithubRateLimit(null);
    });

    es.addEventListener("docker_memory", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as DockerMemoryStats;
      useUiStore.getState().setDockerMemory(data);
    });

    // Account-wide subscription rate-limit snapshots, one entry per
    // fetchable agent backend. The server replaces the map wholesale on
    // every broadcast so sign-outs / unfetchable providers propagate
    // naturally (missing key → no pill). See doc 135.
    es.addEventListener("subscription_limits", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as { limits: SubscriptionLimitsMap };
      useUiStore.getState().setSubscriptionLimits(data.limits);
    });

    // Static process metadata — sent once per SSE connect. The orchestrator's
    // start timestamp powers the UptimeBadge in the header so a "Just Restart"
    // is visible (the value resets when the orchestrator process bounces).
    es.addEventListener("system_info", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as SystemInfo;
      const loadedClientBuildId = getLoadedClientBuildId();
      if (shouldReloadForServerBuild(loadedClientBuildId, data.buildId) && !reloadingForClientUpdate) {
        reloadingForClientUpdate = true;
        window.location.reload();
        return;
      }
      useUiStore.getState().setProcessStartedAt(data.processStartedAt);
      if (data.version) useUiStore.getState().setVersion(data.version);
      useUiStore.getState().setUpdateMode(data.updateMode ?? "manual");
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
