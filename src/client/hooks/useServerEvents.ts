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

let reloadingForClientUpdate = false;

/**
 * Exponential backoff for our own reconnect loop: 1s, 2s, 4s, … capped at 30s.
 * Matches `useWebSocket`'s shape (jitter omitted — one tab, no herd).
 */
function backoffMs(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt), 30_000);
}


/**
 * Per-login sign-in copy.
 *
 * This is the table that replaced eight `agentId === "claude" | "codex"`
 * branches. Those branches existed almost entirely for WORDING — the state
 * transitions on either side of them were identical — plus one flow-specific
 * toast. Keeping the strings as data preserves each flow's exact copy while the
 * logic stays single-path, and adding a third login is a row here rather than
 * another `else if`.
 *
 * An **absent** entry (or an absent `expiry`) is meaningful, not an oversight:
 * it means that flow says nothing extra and shows no re-sign-in toast, which is
 * how a flow with no diagnostics behaves today. The table is the gate.
 */
const AUTH_COPY: Partial<Record<LoginIntegrationId, {
  /** Shown in the diagnostics stream once the challenge arrives. */
  pendingDiagnostic?: string;
  /** Diagnostics line on success. */
  completed?: string;
  /** Fallback per failure reason, when the server sends no message. */
  failure?: Partial<Record<string, string>>;
  /** Generic fallback when `failure` has no entry for the reason. */
  failureDefault?: string;
  /**
   * Toast copy for a credential that expired or vanished underneath the user.
   * Only a flow that can report these reasons declares them.
   */
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
  // planning#435 — the same device-code shape as ChatGPT's, so the same copy.
  // No `pendingDiagnostic`: there is nothing extra to tell the user beyond the
  // URL and code the card already shows, which is exactly the case the table's
  // partiality exists for.
  "xai-oauth": {
    failure: {
      timeout: "Sign-in timed out. Try again.",
      denied: "Sign-in was denied.",
    },
    failureDefault: "Sign-in failed. Try again.",
  },
};

/** The failure string for a reason, honouring the flow's own wording. */
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
      // Reflect the running state in the active session's chat. A system-initiated
      // turn — a wake-up (e.g. resuming after a `shipit agent run` consult with
      // Codex finishes), a child-session notify, Fix CI — has no client-side
      // `send` to set `isLoading`, and a no-echo turn emits no `system_user_message`
      // either, so without this the "Working…" indicator never appears even though
      // the agent is running. Idempotent for user-initiated turns (already loading).
      // Symmetric with the `session_agent_finished` handler that clears it.
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

    // docs/193 (Thread C) — a session is blocked awaiting a permission answer.
    // Two shapes: the connect snapshot (`awaitingPermissionSessionIds`, replaces
    // the set wholesale so a reconnect converges) and the live per-session toggle
    // (`sessionId` + `awaitingPermission`). Drives the sidebar "needs your
    // approval" attention signal even while the user is on another session.
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
        // docs/235 — the snapshot form carries both sets. Reconciled wholesale
        // (not merged) for the same reason as the permission set: this event is
        // authoritative on connect, so a session that drained its tasks while
        // the tab was away must lose its marker rather than keep a stale one.
        // Defaults to empty so an older orchestrator that omits the field
        // clears rather than strands the set.
        // Ids only — the snapshot has no room for task descriptions, so the
        // status line falls back to its unnamed label until the next live
        // `background_tasks` message re-states them.
        store.setBackgroundTaskSessions(
          () => new Map((data.backgroundTaskSessionIds ?? []).map((id) => [id, []])),
        );
        return;
      }
      if (!data.sessionId) return;
      const sid = data.sessionId;
      // Each live form carries exactly one axis, so each is applied only when
      // its own field is present. Reacting to a missing `awaitingPermission` as
      // `false` would let a background-task transition silently clear an
      // outstanding permission prompt's sidebar signal.
      if (data.awaitingPermission !== undefined) {
        store.setAwaitingPermissionSessions((prev) => {
          const next = new Set(prev);
          if (data.awaitingPermission) next.add(sid);
          else next.delete(sid);
          return next;
        });
      }
      // The live counterpart of the snapshot's `backgroundTaskSessionIds`
      // (docs/235 §5b). Without it the sidebar only ever learned about a
      // session's background work if that work was already outstanding when the
      // SSE connected: a `shipit agent run` consult backgrounded *after* connect
      // reached only the viewers attached to that session's WebSocket, so the
      // session read as idle in the sidebar until it was opened — which is what
      // delivered the WS `background_tasks` and lit the dot.
      //
      // An empty list means drained, so the entry is removed. Descriptions ride
      // along (unlike the ids-only snapshot) so the chat status line can name
      // the task on a switch rather than falling back to its unnamed label.
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

    // ---- Unified auth events (docs/155 Phase 2b) ----
    // The orchestrator broadcasts one event family for every LOGIN FLOW's
    // sign-in lifecycle: `agent_auth_pending` (sign-in card content arriving),
    // `agent_auth_complete` (success), `agent_auth_failed` (failure or
    // revocation). The legacy event names (`auth_required`, `auth_complete`,
    // `codex_auth_*`) are gone. A new BACKEND may need nothing here at all — it
    // can sign in through a flow that already exists; a new FLOW is one variant
    // added to the discriminated `details.kind` union, not three new listeners.
    // The handlers below no longer dispatch on WHICH backend sent the event.
    // They branch only on `details.kind` (the one thing the payloads actually
    // differ by) and read per-flow wording from `AUTH_COPY`. The eight
    // `agentId === "claude" | "codex"` branches this replaced were almost
    // entirely about copy, not control flow — so a new backend is a row in that
    // table plus, at most, one new `details.kind` variant.
    //
    // docs/150-multiple-provider-subscriptions req 16/19: every subscription sign-in is account-scoped, so an
    // event without `accountId` has no home and is ignored rather than
    // falling back to a provider-wide slot. The provider-wide slots
    // (`sessionStore.authUrl`, `settingsStore.codexDeviceAuth*`) are gone with
    // the singleton endpoints that fed them. Diagnostics are per account too,
    // and a flow that records none simply no-ops rather than being gated.
    es.addEventListener("agent_auth_pending", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as {
        loginId: LoginIntegrationId;
        accountId?: string;
        details:
          | { kind: "code-paste-url"; verificationUri: string }
          | { kind: "device-code"; verificationUri: string; userCode: string; expiresInSec: number };
      };
      // docs/150-multiple-provider-subscriptions req 16 — a challenge belongs on the row that started it, so an
      // unscoped payload has nowhere to land and is dropped.
      if (!data.accountId) return;
      useSettingsStore.getState().setProviderAccountAuth(data.loginId, data.accountId, {
        loginId: data.loginId,
        accountId: data.accountId,
        verificationUri: data.details.verificationUri,
        // Present only on the device-code shape; the paste-code flow has no
        // second factor to show. Discriminated by `details.kind`, which is what
        // the shapes actually differ by — the backend's identity never was.
        ...(data.details.kind === "device-code" ? { userCode: data.details.userCode } : {}),
      });
      useSettingsStore.getState().setProviderAccountAuthError(data.loginId, data.accountId, null);
      // Advance diagnostics only where an attempt is already in flight. A flow
      // that reports no diagnostics never records one, so this is a no-op for it
      // rather than a case to branch on.
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
      // No-ops when the flow recorded no diagnostics (`finishClaudeAuthDiagnostics`
      // returns early on an account with no attempt), so it needs no gate.
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
      // docs/150-multiple-provider-subscriptions req 22 — a refused duplicate connect usually DELETES the row it
      // names, so the per-row error below has nowhere to land. Skip the
      // retry-flavoured copy too: retrying would only be refused again.
      //
      // docs/257 req 5 — card-scoped rather than row-scoped for that same
      // reason: the row is gone.
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
        // Clearing the challenge flips the sign-in card back to "Sign in" —
        // also the path a refresher-revoked account takes.
        useSettingsStore.getState().setProviderAccountAuth(data.loginId, data.accountId, null);
        useSettingsStore.getState().setProviderAccountAuthError(data.loginId, data.accountId, failure);
        useSettingsStore.getState().finishClaudeAuthDiagnostics(data.accountId, "failed", failure);
      }
      // The re-sign-in toast is per login flow, because only a flow that can
      // report a revoked credential has anywhere to send the user back to.
      // Absent copy means no toast — the table is the gate, not an `if`.
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
      // docs/150 — diagnostics are per account; an unscoped payload has no row
      // that could render it. Only a flow with diagnostics emits this event at
      // all, so there is nothing else to filter on.
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
      // See `agent_auth_progress` above for why an unscoped payload is dropped.
      if (!data.accountId) return;
      useSettingsStore.getState().appendClaudeAuthLog(data.accountId, {
        attemptId: data.attemptId,
        timestamp: data.timestamp,
        level: data.level,
        source: data.source,
        message: data.message,
      });
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
          // 217 — reasoning/effort options; absent on old payloads or agents
          // with no reasoning knob, in which case the controls are hidden.
          reasoning?: { label: string; options: { value: string; label: string }[] };
          skillInvocationPrefix?: string;
        }[];
        // docs/257 req 8 — the install-level "can run a turn" signal, computed
        // server-side. Optional because an older server omits it; in that case
        // the store keeps whatever bootstrap gave it rather than being clobbered
        // with `false`, which would disable the composer on a runnable install.
        canRunTurns?: boolean;
        // docs/257 req 9 — the install-level onboarding stamp, written the
        // moment the server first sees a runnable install. Absent means "no
        // news" (not stamped yet, or an older server), never "cleared" — the
        // server never clears it, so ignoring an absent field cannot strand a
        // stale value.
        harnessOnboardingCompletedAt?: string;
        // docs/261 phase 3 (req 8) — both reviewer slots, re-resolved. This is
        // the whole reason the reviewer resolution rides `agent_list`: the event
        // fires on every credential and harness-availability change, which is
        // exactly when an auto-configured reviewer re-derives. Absent means an
        // older server, so the store keeps what bootstrap gave it.
        reviewers?: ReviewerSlotView[];
        /*
          docs/264 phase 2 — the roles ride this event for the same reason the
          reviewer slots do: a role reports `disconnected` the moment the
          service it names loses its credential, and a Settings tab that does
          not follow that change shows the answer from before it. Absent means
          an older server, so the store keeps what bootstrap gave it.
        */
        roles?: RoleView[];
        /*
          docs/252 req 9 — the background-work setting and what it resolves to,
          re-read on every credential change for the same reason `reviewers` is.
          `null` and absent mean different things here: absent is an older
          server ("no news", keep what bootstrap gave us), while `null` is this
          server saying the value is gone — which is the case that matters, since
          removing the chosen model's credential leaves Settings reporting a
          harness that background work can no longer reach.
        */
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
        supportedPermissionModes: a.supportedPermissionModes,
      }));
      useUiStore.getState().setAgentList(agents);
      // If the currently selected agent isn't installed-and-authed, redirect the
      // picker to the first agent that is — AND persist it. The picker hydrates
      // from localStorage (default `agent = "claude"` / no model), which is wrong
      // on a Codex-only install. Persisting matters because the per-session WS
      // connection derives its effective agent from the saved model/agent at
      // connect time: without it the picker would *show* the authed agent while
      // the first turn still connected as the unauthed one and got rejected by
      // the server's auth gate, until the user round-tripped the selector. See
      // resolveAuthedSelection / docs/142.
      //
      // Both directions, because a credential coming back is delivered on this
      // same event and used to be ignored: the redirect below is persistent by
      // design and used to be PERMANENT by accident, so a transient
      // `auth_failed` moved the user to the other harness for good. The restore
      // runs first — a harness that can be handed back is never also a harness
      // to redirect away from, and doing it in the other order would re-park
      // what it had just restored.
      const activeAgentId = useUiStore.getState().activeAgentId;
      const parked = getParkedHarness();
      const restoreTo = resolveParkedRestore(agents, parked);
      if (restoreTo) {
        const agentId = restoreTo.id as AgentId;
        // Through the same writer a deliberate pick uses, so the restored
        // harness and the restored model agree — handing back `vibe-agent-id`
        // alone would be outvoted by the redirect's model exactly as the
        // composer's own pick was. It clears the park as part of the write.
        // Same question the redirect's notice asks, for the same reason: did the
        // SEED move? `activeAgentId` would answer about the session being
        // viewed, and stay silent whenever that session happens to run the
        // harness being handed back.
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
        // **What is being taken away is the SEED, and the seed is not
        // `activeAgentId`.** That field is synced to whichever session is being
        // VIEWED (`useConnectionSync`), on purpose — it answers "what is this
        // session running on". The seed answers "what will the next session be
        // created on", and `newSessionAgentId` is that rule.
        //
        // Reading the wrong one gets both halves wrong. Open an old Codex
        // session while the seed is Claude/Opus, and let Codex's credential
        // fail: the redirect is a no-op for the seed (it writes Claude/Opus back
        // over Claude/Opus) but parked `{codex, Opus}` — an incoherent pair the
        // user never chose, which on Codex's recovery would be restored and
        // would replace their Claude seed with Codex's first model. And on every
        // reconnect after a real redirect, `useConnectionSync` re-syncs
        // `activeAgentId` to the viewed session's dead harness, so the same
        // redirect re-ran and re-toasted for the whole outage.
        //
        // So both the park and the notice are gated on the seed actually moving.
        // Everything below the gate — the in-memory correction and the persisted
        // writes — still runs unconditionally, because that is C4's job and it
        // is idempotent when nothing moved.
        const seedAgentId = newSessionAgentId(agents);
        const seedModelId = getSavedModelId();
        const displacesSeed =
          redirect.agentId !== seedAgentId
          || (!!redirect.modelId && redirect.modelId !== seedModelId);
        // Park BEFORE overwriting, and only when nothing is parked yet — a
        // second redirect must not overwrite the user's own choice with the
        // machine's.
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
        // Say so. The redirect changes the single most consequential and
        // irreversible fact about every session created from here on, and it
        // used to happen silently — the user found out by noticing a different
        // name in a dropdown, if at all.
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

    // docs/252 phase 2 — a credential was added, edited, removed or reordered
    // in another tab. Same shape and the same reason as `provider_accounts`
    // above; the two are separate events because they have separate writers
    // (the docs/150 account flow, and the credential-route endpoints).
    es.addEventListener("credential_routes", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as { routes: CredentialRoute[] };
      useSettingsStore.getState().setCredentialRoutes(data.routes);
    });

    // docs/172 / planning#92 — egress containment settings changed in another tab.
    // Refresh the effective allowlist view so the Settings → Network egress
    // editor stays in sync. Only when already loaded (the panel was opened),
    // so a background tab that never opened Settings doesn't fetch.
    es.addEventListener("egress_settings", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as EgressSettings;
      const store = useEgressStore.getState();
      if (!store.loaded) return;
      // Reflect the toggle + enforcement state immediately, then re-fetch the
      // full provenance view.
      useEgressStore.setState({ globalEnabled: data.globalEnabled, enforcementActive: data.enforcementActive });
      void store.refresh().catch(() => {});
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

    // docs/171 — the release lifecycle card is a persisted transcript card now
    // (delivered over the per-session WS as `release_card` and rehydrated from
    // chat history), so there is no longer a `release_status` SSE to handle here.

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
        reason?: "agent-reclaimed" | "memory-pressure";
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
      // …and from the background-work set, for the same reason. The container
      // is gone, so nothing can still be outstanding in it — and the disposal
      // paths clear the runner's own trackers directly, without a draining
      // event of their own. Without this the sidebar dot would keep pulsing on
      // a reaped session until the next SSE connect.
      useSessionStore.getState().setBackgroundTaskSessions((prev) => {
        if (!prev.has(data.sessionId)) return prev;
        const next = new Map(prev);
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

    // A stream that opened is a healthy generation — restart the backoff ladder
    // so the next outage retries promptly instead of inheriting an old delay.
    es.onopen = () => {
      reconnectAttemptRef.current = 0;
    };

    es.onerror = () => {
      // CONNECTING means the browser's own auto-reconnect is already in flight
      // (a plain network error) — leave it alone. CLOSED means the connection
      // was *failed*, which the browser never retries: a non-200 / non-
      // `text/event-stream` response, i.e. the ingress's 502 page while the
      // orchestrator restarts. That is ours to recover from.
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

  // Force a fresh SSE connection when the app returns from the background, or
  // when the network comes back. Native EventSource readyState often stays OPEN
  // over a dead socket on mobile, so we tear down and re-open instead of waiting
  // for a (never-firing) error event. Closing the previous EventSource and
  // cancelling any pending backoff timer are both handled by the effect's
  // cleanup, which re-runs when `connectAttempt` changes. The attempt counter is
  // reset first so a user-visible return to the app reconnects immediately
  // rather than inheriting a long backoff delay from the outage.
  //
  // Which events count as a resume — and why a bare window `focus` does not —
  // lives in `useForegroundSignal`, shared with `useWebSocket` so the two
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
