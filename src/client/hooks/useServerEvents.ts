// eslint-disable-next-line no-restricted-imports -- useEffect: EventSource (SSE) connection lifecycle with cleanup (external system sync)
import { useEffect, useRef, useState } from "react";
import type { LoginIntegrationId } from "../../server/shared/catalogue/types.js";
import { useSessionStore } from "../stores/session-store.js";
import { useRepoStore } from "../stores/repo-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { usePrStore } from "../stores/pr-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { useEgressStore } from "../stores/egress-store.js";
import type { ToastData } from "../components/Toast.js";
import { fullResetAllStores } from "../stores/actions/session-actions.js";
import type { AgentId, SessionInfo, RepoInfo, PrStatusSummary, DockerMemoryStats, SystemInfo, SubscriptionLimitsMap, PermissionMode, CredentialRoute, EgressSettings } from "../../server/shared/types.js";
import type { ReviewerSlotView, RoleView } from "../../server/shared/types/agent-types.js";
import { getLoadedClientBuildId, shouldReloadForServerBuild } from "../utils/client-build.js";
import {
  getParkedHarness,
  getSavedModelId,
  getSavedModelSelection,
  saveAgentId,
  saveModelId,
  saveParkedHarness,
} from "../utils/local-storage.js";
import { persistHarnessPick } from "../utils/harness-seed.js";
import { newSessionAgentId } from "../utils/new-session-agent.js";
import { resolveAuthedSelection, resolveParkedRestore } from "../utils/resolve-authed-selection.js";
import { useForegroundSignal } from "./useForegroundSignal.js";
import { notifySessionNetworkModeChanged } from "./useSessionNetworkMode.js";
import { notifyPreviewsStopped } from "./usePreviewsStopped.js";

let reloadingForClientUpdate = false;

function backoffMs(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt), 30_000);
}

const AUTH_COPY: Partial<Record<LoginIntegrationId, {

  pendingDiagnostic?: string;

  completed?: string;

  failure?: Partial<Record<string, string>>;

  failureDefault?: string;

  expiry?: Partial<Record<"revoked" | "missing_credentials", string>>;
}>> = {
  "anthropic-oauth": {
    pendingDiagnostic:
      "Authentication link received. Paste the authorization code after signing in.",
    completed: "Claude sign-in completed.",
    failure: {
      missing_credentials: "Claude credentials are missing. Sign in again.",
    },
    failureDefault: "Claude sign-in failed. You can retry or copy the diagnostic details.",
    expiry: {
      revoked: "Claude authentication expired. Sign in again.",
      missing_credentials: "Claude credentials are missing. Sign in again.",
    },
  },
  "openai-chatgpt": {
    failure: {
      timeout: "Sign-in timed out. Try again.",
      denied: "Sign-in was denied.",
    },
    failureDefault: "Sign-in failed. Try again.",
  },

  "xai-oauth": {
    failure: {
      timeout: "Sign-in timed out. Try again.",
      denied: "Sign-in was denied.",
    },
    failureDefault: "Sign-in failed. Try again.",
  },
};

function failureCopy(
  copy: (typeof AUTH_COPY)[LoginIntegrationId],
  reason: string | undefined,
): string {
  return (
    (reason ? copy?.failure?.[reason] : undefined)
    ?? copy?.failureDefault
    ?? "Sign-in failed. Try again."
  );
}

/**
 * SSE hook for global push events — session list, repo updates, auth, activity dots.
 * Always active (home page and session page). Replaces WS broadcasts for global state.
 *
 * Mobile resilience: when the tab is backgrounded (user switches apps), the OS
 * often silently terminates the underlying TCP connection. Native EventSource
 * keeps `readyState === OPEN` and never fires `error`, so its built-in
 * auto-reconnect never triggers and PR/CI status updates stop arriving — the
 * UI shows stale data until the user reloads the page. We force a fresh
 * connection whenever the app returns to the foreground; the server re-sends its
 * snapshot (PR statuses, sessions, repos — see `/api/events` initial-state
 * writes) so the UI catches up immediately.
 *
 * That foreground signal must be the SAME set the WebSocket listens for, on the
 * same terms — hence the shared `useForegroundSignal`, not a second hand-rolled
 * listener set — and NOT `visibilitychange` alone. A standalone-PWA app-switch
 * or a bfcache restore surfaces as `pageshow`/`focus` with `visibilitychange`
 * either absent or already delivered while the page was frozen, so a
 * visibility-only trigger misses the resume the
 * WebSocket recovers from. That asymmetry is directly visible in the product:
 * the chat reconnects and looks healthy while every *cross-session* surface fed
 * only by SSE — the sidebar's PR / CI indicators above all, since
 * `/api/bootstrap` carries no PR state and nothing else re-fetches it — stays
 * frozen at its pre-background values until a full page reload.
 *
 * Restart resilience: native EventSource auto-reconnect only covers *network*
 * errors. Per the HTML spec, a response that is not `200 text/event-stream`
 * **fails the connection permanently** — readyState goes to CLOSED and the
 * browser never retries. That is exactly what an orchestrator restart produces:
 * while the container is being replaced, the ingress (cloudflared) answers with
 * a 502 HTML error page, so any retry landing inside that window kills the
 * stream for the lifetime of the page. The WebSocket has its own backoff loop
 * and comes back, so the app *looks* connected while SSE is silently dead — and
 * because the post-update page reload is driven by the `system_info` build id
 * delivered on SSE *connect*, the tab never reloads onto the new client bundle
 * (it also strands the session list, PR status and version badge). So we own the
 * retry: on CLOSED we reconnect with backoff instead of giving up.
 */
export function useServerEvents(): void {
  const eventSourceRef = useRef<EventSource | null>(null);
  const [connectAttempt, setConnectAttempt] = useState(0);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      const data = JSON.parse(e.data as string) as { sessionId: string; activity?: string };
      const store = useSessionStore.getState();
      store.setActiveRunnerSessions((prev) => {
        const next = new Set(prev);
        next.add(data.sessionId);
        return next;
      });

      // either, so without this the "Working…" indicator never appears even though

      if (data.sessionId === store.sessionId) {
        store.setIsLoading(true);
        if (data.activity) store.setActivity({ label: data.activity });
      }
    });

    es.addEventListener("session_agent_finished", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as { sessionId: string };
      const store = useSessionStore.getState();
      store.setActiveRunnerSessions((prev) => {
        const next = new Set(prev);
        next.delete(data.sessionId);
        return next;
      });

      if (data.sessionId === store.sessionId) {
        store.setIsLoading(false);
        store.setActivity(undefined);
      }
    });

    es.addEventListener("active_runners", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as {
        sessionIds: string[];
        runnerIncarnations?: Record<string, number>;
      };
      useSessionStore.getState().setActiveRunnerSessions(() => new Set(data.sessionIds));

      // session cannot tell a replacement from its first observation, and a
      // `/new` viewer usually has none because its first snapshot predates the

      if (data.runnerIncarnations) {
        useSessionStore.getState().noteRunnerIncarnations(data.runnerIncarnations);
      }
    });

    // re-read, so two surfaces over one value cannot disagree — including across

    es.addEventListener("session_egress_changed", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as { sessionId: string };
      notifySessionNetworkModeChanged(data.sessionId);
    });

    // (a full container teardown, the idle enforcer's tier 2), never for the

    es.addEventListener("session_previews_stopped", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as { sessionId: string };
      notifyPreviewsStopped(data.sessionId);
    });

    // next reconnect" into "recovers now", and losing it costs latency, never
    // correctness. Session-scoped and merged, so it cannot drop what it does not

    es.addEventListener("runner_replaced", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as { sessionId: string; incarnation: number };
      useSessionStore
        .getState()
        .noteRunnerIncarnations(
          { [data.sessionId]: data.incarnation },
          { merge: true, live: true },
        );
    });

    es.addEventListener("session_attention", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as {
        awaitingPermissionSessionIds?: string[];
        backgroundTaskSessionIds?: string[];
        sessionId?: string;
        awaitingPermission?: boolean;
        backgroundTasks?: string[];
      };
      const store = useSessionStore.getState();
      if (Array.isArray(data.awaitingPermissionSessionIds)) {
        store.setAwaitingPermissionSessions(() => new Set(data.awaitingPermissionSessionIds));

        // the tab was away must lose its marker rather than keep a stale one.

        store.setBackgroundTaskSessions(
          () => new Map((data.backgroundTaskSessionIds ?? []).map((id) => [id, []])),
        );
        return;
      }
      if (!data.sessionId) return;
      const sid = data.sessionId;

      if (data.awaitingPermission !== undefined) {
        store.setAwaitingPermissionSessions((prev) => {
          const next = new Set(prev);
          if (data.awaitingPermission) next.add(sid);
          else next.delete(sid);
          return next;
        });
      }

      if (data.backgroundTasks) {
        const descriptions = data.backgroundTasks;
        store.setBackgroundTaskSessions((prev) => {
          const next = new Map(prev);
          if (descriptions.length > 0) next.set(sid, descriptions);
          else next.delete(sid);
          return next;
        });
      }
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

    es.addEventListener("agent_auth_pending", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as {
        loginId: LoginIntegrationId;
        accountId?: string;
        details:
          | { kind: "code-paste-url"; verificationUri: string }
          | { kind: "device-code"; verificationUri: string; userCode: string; expiresInSec: number };
      };

      if (!data.accountId) return;
      useSettingsStore.getState().setProviderAccountAuth(data.loginId, data.accountId, {
        loginId: data.loginId,
        accountId: data.accountId,
        verificationUri: data.details.verificationUri,

        // the shapes actually differ by — the backend's identity never was.
        ...(data.details.kind === "device-code" ? { userCode: data.details.userCode } : {}),
      });
      useSettingsStore.getState().setProviderAccountAuthError(data.loginId, data.accountId, null);

      // that reports no diagnostics never records one, so this is a no-op for it

      const currentAttemptId =
        useSettingsStore.getState().claudeAuthDiagnostics[data.accountId]?.attemptId;
      if (currentAttemptId) {
        useSettingsStore.getState().setClaudeAuthProgress(data.accountId, {
          attemptId: currentAttemptId,
          phase: "waiting_for_code",
          message: AUTH_COPY[data.loginId]?.pendingDiagnostic
            ?? "Authentication link received.",
        });
      }
    });

    es.addEventListener("agent_auth_complete", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as {
        loginId: LoginIntegrationId;
        accountId?: string;
      };
      if (!data.accountId) return;
      useSettingsStore.getState().setProviderAccountAuth(data.loginId, data.accountId, null);
      useSettingsStore.getState().setProviderAccountAuthError(data.loginId, data.accountId, null);

      useSettingsStore.getState().finishClaudeAuthDiagnostics(
        data.accountId,
        "complete",
        AUTH_COPY[data.loginId]?.completed,
      );
    });

    es.addEventListener("agent_auth_failed", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as {
        loginId: LoginIntegrationId;
        accountId?: string;
        reason?: "timeout" | "denied" | "error" | "revoked" | "missing_credentials" | "duplicate";
        message?: string;
      };
      const copy = AUTH_COPY[data.loginId];

      if (data.reason === "duplicate") {
        useSettingsStore.getState().setProviderAccountNotice(data.loginId, {
          kind: "error",
          message: data.message ?? "That account is already connected.",
        });
        if (data.accountId) {
          useSettingsStore.getState().setProviderAccountAuth(data.loginId, data.accountId, null);
        }
        return;
      }
      const failure = data.message ?? failureCopy(copy, data.reason);
      if (data.accountId) {

        useSettingsStore.getState().setProviderAccountAuth(data.loginId, data.accountId, null);
        useSettingsStore.getState().setProviderAccountAuthError(data.loginId, data.accountId, failure);
        useSettingsStore.getState().finishClaudeAuthDiagnostics(data.accountId, "failed", failure);
      }
      // The re-sign-in toast is per login flow, because only a flow that can

      const expiryToast = data.reason === "revoked" || data.reason === "missing_credentials"
        ? copy?.expiry?.[data.reason]
        : undefined;
      if (expiryToast) {
        useUiStore.getState().setToast({
          message: data.message ?? expiryToast,
          action: {
            label: "Sign in",
            onClick: () => {
              useUiStore.getState().setSettingsTab("services");
              useUiStore.getState().setSettingsOpen(true);
            },
          },
          duration: 12000,
        });
      }
    });

    es.addEventListener("agent_auth_progress", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as {
        loginId: LoginIntegrationId;
        accountId?: string;
        attemptId: string;
        phase: "starting" | "waiting_for_cli" | "skipping_setup" | "waiting_for_url" | "waiting_for_code" | "checking_credentials" | "complete" | "failed";
        message: string;
        elapsedMs?: number;
      };

      if (!data.accountId) return;
      useSettingsStore.getState().setClaudeAuthProgress(data.accountId, {
        attemptId: data.attemptId,
        phase: data.phase,
        message: data.message,
        ...(data.elapsedMs !== undefined ? { elapsedMs: data.elapsedMs } : {}),
      });
    });

    es.addEventListener("agent_auth_log", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as {
        loginId: LoginIntegrationId;
        accountId?: string;
        attemptId: string;
        timestamp: string;
        level: "debug" | "info" | "warn" | "error";
        source: "shipit" | "claude_stdout" | "claude_stderr" | "claude_control";
        message: string;
      };

      if (!data.accountId) return;
      useSettingsStore.getState().appendClaudeAuthLog(data.accountId, {
        attemptId: data.attemptId,
        timestamp: data.timestamp,
        level: data.level,
        source: data.source,
        message: data.message,
      });
    });

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
              useUiStore.getState().setSettingsTab("integrations");
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
          hasRunnableModels: boolean;
          models?: string[];

          supportsReview?: boolean;

          supportsCompaction?: boolean;
          supportsGoals?: boolean;

          supportedPermissionModes?: PermissionMode[];

          reasoning?: { label: string; options: { value: string; label: string }[] };
          skillInvocationPrefix?: string;
        }[];

        // server-side. Optional because an older server omits it; in that case

        canRunTurns?: boolean;

        // news" (not stamped yet, or an older server), never "cleared" — the
        // server never clears it, so ignoring an absent field cannot strand a

        harnessOnboardingCompletedAt?: string;

        reviewers?: ReviewerSlotView[];

        roles?: RoleView[];

        nonTurnModel?: { serviceId: string; billingMode: "sub" | "key"; modelId: string } | null;
        nonTurnModelResolved?: {
          serviceId: string;
          billingMode: "sub" | "key";
          modelId: string;
          serviceName: string;
          label: string;
          harnessId: string;
          source: "pinned" | "default";
        } | null;
      };
      if (data.reviewers) {
        useSettingsStore.getState().setReviewers(data.reviewers);
      }
      if (data.roles) {
        useSettingsStore.getState().setRoles(data.roles);
      }
      if (data.nonTurnModel !== undefined || data.nonTurnModelResolved !== undefined) {
        useSettingsStore.getState().setNonTurnModel(
          data.nonTurnModel ?? null,
          data.nonTurnModelResolved ?? null,
        );
      }
      if (typeof data.canRunTurns === "boolean") {
        useSettingsStore.getState().setCanRunTurns(data.canRunTurns);
      }
      if (typeof data.harnessOnboardingCompletedAt === "string") {
        useSettingsStore.getState()
          .setHarnessOnboardingCompletedAt(data.harnessOnboardingCompletedAt);
      }
      const agents = data.agents.map((a) => ({
        ...a,
        models: a.models ?? [],
        supportsReview: a.supportsReview ?? false,
        supportsCompaction: a.supportsCompaction ?? false,
        supportsGoals: a.supportsGoals ?? false,
        supportedPermissionModes: a.supportedPermissionModes,
      }));
      useUiStore.getState().setAgentList(agents);

      // on a Codex-only install. Persisting matters because the per-session WS

      // Both directions, because a credential coming back is delivered on this

      // runs first — a harness that can be handed back is never also a harness

      const activeAgentId = useUiStore.getState().activeAgentId;
      const parked = getParkedHarness();
      const restoreTo = resolveParkedRestore(agents, parked);
      if (restoreTo) {
        const agentId = restoreTo.id as AgentId;

        const seedMoved = newSessionAgentId(agents) !== agentId;
        persistHarnessPick({ agentId, agents, ...(parked?.model ? { current: parked.model } : {}) });
        useUiStore.getState().setActiveAgentId(agentId);
        if (seedMoved) {
          useUiStore.getState().setToast({
            message: `${restoreTo.name} is available again — switched back to it.`,
            duration: 8000,
          });
        }
        return;
      }
      const redirect = resolveAuthedSelection(agents, activeAgentId, getSavedModelId());
      if (redirect) {

        // user never chose, which on Codex's recovery would be restored and

        // writes — still runs unconditionally, because that is C4's job and it

        const seedAgentId = newSessionAgentId(agents);
        const seedModelId = getSavedModelId();
        const displacesSeed =
          redirect.agentId !== seedAgentId
          || (!!redirect.modelId && redirect.modelId !== seedModelId);

        // second redirect must not overwrite the user's own choice with the

        if (displacesSeed && !parked) {
          const saved = getSavedModelSelection();
          saveParkedHarness({
            agentId: seedAgentId,
            ...(seedModelId
              ? {
                  model: {
                    modelId: seedModelId,
                    ...(saved ? { serviceId: saved.serviceId, billingMode: saved.billingMode } : {}),
                  },
                }
              : {}),
          });
        }
        useUiStore.getState().setActiveAgentId(redirect.agentId);
        saveAgentId(redirect.agentId);
        if (redirect.modelId) saveModelId(redirect.modelId);

        if (displacesSeed) {
          const from = agents.find((a) => a.id === seedAgentId);
          const to = agents.find((a) => a.id === redirect.agentId);
          useUiStore.getState().setToast({
            message:
              `${from?.name ?? seedAgentId} has no usable credential right now — `
              + `new sessions will run on ${to?.name ?? redirect.agentId}.`,
            action: {
              label: "Settings",
              onClick: () => {
                useUiStore.getState().setSettingsTab("services");
                useUiStore.getState().setSettingsOpen(true);
              },
            },
            duration: 12000,
          });
        }
      }
    });

    es.addEventListener("provider_accounts", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as { accounts: CredentialRoute[] };
      useSettingsStore.getState().setProviderAccounts(data.accounts);
    });

    // above; the two are separate events because they have separate writers

    es.addEventListener("credential_routes", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as { routes: CredentialRoute[] };
      useSettingsStore.getState().setCredentialRoutes(data.routes);
    });

    // so a background tab that never opened Settings doesn't fetch.
    es.addEventListener("egress_settings", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as EgressSettings;
      const store = useEgressStore.getState();

      // that `Inherit` resolves to. A surface showing a value it never updates

      useEgressStore.setState({
        globalEnabled: data.globalEnabled,
        enforcementActive: data.enforcementActive,
        enforcementStatus: data.enforcementStatus
          ?? (data.enforcementActive ? "active" : "no-sidecar"),
        globalLoaded: true,
      });

      if (!store.loaded) return;
      void store.refresh().catch(() => {});
    });

    es.addEventListener("pr_status", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as {
        updates: PrStatusSummary[];
        removals?: string[];

        isSnapshot?: boolean;
      };
      usePrStore.getState().applyPrStatusUpdates(data.updates, data.removals, data.isSnapshot);
    });

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

    es.addEventListener("subscription_limits", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as { limits: SubscriptionLimitsMap };
      useUiStore.getState().setSubscriptionLimits(data.limits);
    });

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

    es.addEventListener("session_status", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as {
        sessionId: string;
        running?: boolean;
        reason?: "agent-reclaimed" | "memory-pressure";
        idleMs?: number;
      };

      useSessionStore.getState().setActiveRunnerSessions((prev) => {
        if (!prev.has(data.sessionId)) return prev;
        const next = new Set(prev);
        next.delete(data.sessionId);
        return next;
      });

      useSessionStore.getState().setBackgroundTaskSessions((prev) => {
        if (!prev.has(data.sessionId)) return prev;
        const next = new Map(prev);
        next.delete(data.sessionId);
        return next;
      });

      // precisely because it has just disposed the runner the WS path needs, so
      // the health strip's explanation would otherwise never render for the one

      if (
        (data.reason === "agent-reclaimed" || data.reason === "memory-pressure")
        && useSessionStore.getState().sessionId === data.sessionId
      ) {
        useSessionStore.getState().setPauseNotice({
          reason: data.reason,
          ...(data.idleMs !== undefined ? { idleMs: data.idleMs } : {}),
          at: Date.now(),
        });
      }
    });

    es.addEventListener("full_reset_complete", () => {
      fullResetAllStores();

      if (window.location.pathname !== "/") {
        window.location.href = "/";
      }
    });

    es.addEventListener("server_error", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data as string) as { message: string };
        console.error("[sse] Server error:", data.message);
      } catch {
        // Malformed data — ignore
      }
    });

    es.onopen = () => {
      reconnectAttemptRef.current = 0;
    };

    es.onerror = () => {

      // was *failed*, which the browser never retries: a non-200 / non-

      if (es.readyState !== EventSource.CLOSED) return;
      const attempt = reconnectAttemptRef.current;
      reconnectAttemptRef.current = attempt + 1;
      const delay = backoffMs(attempt);
      console.warn(`[sse] Connection closed — reconnecting in ${delay}ms`);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(() => setConnectAttempt((n) => n + 1), delay);
    };

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      es.onopen = null;
      es.onerror = null;
      es.close();
      eventSourceRef.current = null;
    };
  }, [connectAttempt]);

  // for a (never-firing) error event. Closing the previous EventSource and

  // channels can never drift apart on that question again.
  useForegroundSignal({
    onForeground: () => {
      reconnectAttemptRef.current = 0;
      setConnectAttempt((n) => n + 1);
    },
    isConnectionLive: () =>
      eventSourceRef.current !== null &&
      eventSourceRef.current.readyState !== EventSource.CLOSED,
  });
}
