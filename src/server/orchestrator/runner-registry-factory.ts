import { readSessionAccountMarker, readSessionResidentRoute } from "./session-credentials.js";
import { queuedMessageToDispatchOptions } from "./prepared-dispatch.js";
import type { GitManager } from "../shared/git.js";
import type { SessionRunnerFactory } from "./session-runner.js";
import { AgentTurnAdmissionError, SessionRunnerRegistry, dispatchOnRunner } from "./session-runner.js";
import type { SessionRunnerInterface, SystemTurnDeps } from "./session-runner.js";
import type { SessionManager } from "./sessions.js";
import { billingModeForRoute } from "./sessions.js";
import type { ProviderRouteKind } from "../shared/types/domain-types/provider.js";
import type { RepoStore } from "./repo-store.js";
import type { ChatHistoryManager } from "./chat-history.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { ServiceManager } from "./service-manager.js";
import type { SessionContainerManager } from "./session-container.js";
import type { CredentialStore } from "./credential-store.js";
import type { SecretStore } from "./secret-store.js";
import type { PrStatusPoller } from "./pr-status-poller.js";
import type { AutoConflictResolveManager } from "./auto-conflict-resolve-manager.js";
import type { AgentId, AgentProcess, LogSource, SubscriptionLimitsMap, SessionInfo } from "../shared/types.js";
import type { ContainerSessionRunner } from "./container-session-runner.js";
import type { DepDirPublishOutcome } from "./overlay-publish.js";
import type { RuntimeMode } from "./app-di.js";
import type { LogStore } from "./log-store.js";
import type { UsageManager } from "./usage.js";
import type { PrepareRunParamsFn } from "./agent-run-params-prep.js";
import type { ProviderAccountManager } from "./provider-account-manager.js";
import type { TurnOutcome } from "./turn-settlement.js";
import type { AutoPushScheduler } from "./services/auto-push-scheduler.js";
import { applyShipitConfigChange, emitPluginReposUpdated, setupServiceManager, type ServiceSetupDeps } from "./service-manager-setup.js";
import { clearActivationState } from "./services/plugin-activation.js";
import { buildAgentRunParams } from "./session-agent-run-params.js";
import { applyModelRetirement } from "./model-retirement.js";
import {
  finalizeSessionAgentEnvironment,
  prepareSessionAgentEnvironment,
  repushSessionAgentToken,
} from "./session-agent-env.js";
import { emitPrLifecycleAfterCommit } from "./services/pr-lifecycle.js";
import { detectAndReArmMergedSession, detectAndReArmResetSession } from "./services/pr-rearm.js";
import { applyPreTurnReset } from "./pre-turn-reset-hook.js";
import { emitResetEligible } from "./services/pre-turn-reset.js";
import { wireResetEligibleOnFileChange } from "./reset-eligible-watch.js";
import { postTurnCommit } from "./ws-handlers/post-turn.js";
import { routeVoiceNote } from "./voice/voice-note-router.js";
import type { VoiceNotePayload, VoiceNoteSource } from "../shared/types/voice-note-types.js";
import { getAgentCapabilities } from "../shared/agent-registry.js";
import { residentRouteNeedsRelease} from "./service-routing.js";
import type { GenerateText } from "./non-turn-model.js";

// ---- Runner registry setup ----

/** Dependencies for runner registry creation. */
export interface RunnerRegistryDeps {
  effectiveRunnerFactory: SessionRunnerFactory | undefined;
  sessionManager: SessionManager;
  /**
   * docs/178 — repo trust store, forwarded into `setupServiceManager` so the
   * per-session compose/install setup defers repo-declared auto-execution for
   * an untrusted remote.
   */
  repoStore: RepoStore;
  createGitManager: (dir: string) => GitManager;
  githubAuthManager: GitHubAuthManager;
  agentFactory: ((agentId: AgentId) => AgentProcess) | undefined;
  chatHistoryManager: ChatHistoryManager;
  /**
   * Session-keyed debounced auto-push. Owned by the app, not by a runner, so a
   * push armed by a turn survives the runner being reclaimed a moment later.
   */
  autoPushScheduler: AutoPushScheduler;
  sseBroadcast: (event: string, data: unknown) => void;
  enforceIdleContainerLimit: () => void;
  getDepCacheDir: (repoUrl: string) => string;
  /** Per-session ServiceManager registry (compose stacks). */
  serviceManagers: Map<string, ServiceManager>;
  /**
   * Per-session in-flight compose-stop promises. Populated in a runner's
   * `disposed` handler with the promise returned by `mgr.stop()` and cleared
   * when that promise settles. The next `setupServiceManager` for the same
   * session awaits the pending stop before calling `mgr.start()` — without
   * this gate, the old `docker compose down -p shipit-{sid12}` runs in
   * parallel with the new `compose up -p shipit-{sid12}` (same project
   * name = same session ID prefix) and tears down the new agent container
   * as collateral, producing the SIGTERM/recreate loop observed in
   * production. See docs/124-session-rescue-and-diagnostics follow-up.
   */
  composeStopPromises: Map<string, Promise<void>>;
  /** Per-session compose warnings for old-format configs without a ServiceManager. */
  composeWarnings: Map<string, string>;
  /** Sessions where compose is not configured in shipit.yaml. */
  composeNotConfigured: Set<string>;
  /** Container manager for connecting agent containers to compose networks. */
  containerManager: SessionContainerManager | null;
  /**
   * Account-level credential store (docs/088). Used to wire ServiceManager's
   * `accountAgentEnvLoader` (merging MCP secrets and the user's stored service
   * credentials into the agent env) and to
   * trigger MCP npm-package installs at session activation. Optional so test
   * setups without credentials still work.
   */
  credentialStore?: CredentialStore;
  /**
   * Per-repo secret store. Used to auto-load secrets into compose services on
   * session activation — wired into ServiceManager via its `secretsLoader`
   * callback. Optional so test setups without secrets still work.
   */
  secretStore?: SecretStore;
  /**
   * Phase 1 follow-up — when set, ServiceManager uses Docker-secrets
   * isolation instead of env files. See `ServiceManagerOptions.dockerSecretsConfig`
   * for field semantics.
   */
  dockerSecretsConfig?: {
    internalDir: string;
    hostDir?: string;
    entrypointSourcePath: string;
  };
  /**
   * docs/183 — orchestrator-private root for per-service compose env files,
   * outside the agent's workspace mount. Forwarded into `setupServiceManager`
   * → `ServiceManager`, both of which require it (planning#292). See
   * `ServiceManagerOptions.serviceEnvDir`.
   */
  serviceEnvDir: string;
  /** docs/192 — durable log store, forwarded to `setupServiceManager` for service-log persistence. */
  logStore?: LogStore;
  /**
   * Runtime mode. In `"local"` mode, ServiceManager is not constructed for
   * inner sessions (no Docker → no Compose). The compose-not-configured
   * event is also suppressed at the source so the inner UI doesn't see it
   * for every session creation. See feature 118.
   */
  runtimeMode: RuntimeMode;
  /**
   * Per-session log broadcaster. Routes diagnostic strings into the Logs
   * panel + per-session ring buffer. Wired here so compose-stack failures
   * (`ServiceManager.emit("stack_error")`) and other manager-level signals
   * land in the user-visible Logs view rather than the orchestrator's
   * stdout. See docs/124-session-rescue-and-diagnostics §1.1.
   */
  broadcastLog: (sessionId: string, source: LogSource, text: string) => void;
  /**
   * docs/149 — credentials root used by the post-system-turn finalize hook
   * (writes a CLI-rotated OAuth token back to the orchestrator source).
   * Optional so test setups without container creds still work.
   */
  credentialsDir?: string;
  /**
   * docs/150 — provider-account router, used by the system-turn env-prep hook
   * so a dispatched turn (child session, CI fix, wake) runs the same
   * account-routing preflight the WS path does. Optional: without it the hook
   * keeps the pre-docs/150 behavior of provisioning the legacy credential
   * subtree and never blocking on quota.
   */
  providerAccountManager?: ProviderAccountManager;
  /**
   * docs/149 — used by the system-turn `buildRunParams` hook to load the
   * user's optional Settings > Instructions suffix. Optional so test setups
   * can skip the file read.
   */
  readSystemPrompt?: () => Promise<string | undefined>;
  /**
   * docs/149 — used by the post-system-turn PR-lifecycle flow when auto-
   * create-PR is on, to derive a PR description from chat history. Optional
   * so tests can leave the flow unwired.
   */
  generateText?: GenerateText;
  /**
   * docs/149 — lazy resolver for the PR-status poller. Lazy because the
   * poller is constructed AFTER the runner registry (it depends on the
   * registry) — without a getter the post-turn flow would close over a null
   * reference. Optional so tests omit it.
   */
  getPrStatusPoller?: () => PrStatusPoller | undefined;
  /**
   * docs/146 — lazy resolver for the auto-conflict-resolve manager. The
   * manager is constructed inside the poller (one tick after the registry
   * exists), so we accept a lazy getter rather than a direct ref. Wired so
   * the runner's `"idle"` event re-evaluates any session whose manager state
   * is `deferred`. Optional — when absent, the runner-idle hook just keeps
   * doing what `enforceIdleContainerLimit` did before.
   */
  getAutoConflictResolveManager?: () => AutoConflictResolveManager | undefined;
  /**
   * planning#266 — re-acquire the completion settlement for a server-side DELIVERY
   * whose turn outlived an orchestrator restart, keyed by the delivery id the
   * worker reports. Threaded into every runner's `SystemTurnDeps` so turn
   * adoption can settle the ORIGINAL watch from the adopted turn instead of a
   * duplicate being dispatched over it.
   *
   * Lazy in the same way (and for the same reason) as `getPrStatusPoller`: the
   * merge-watch manager is constructed after the registry it dispatches into.
   * Optional — a setup without it adopts turns exactly as before.
   */
  rebindDelivery?: (deliveryId: string) => ((outcome: TurnOutcome) => void) | undefined;
  /**
   * Usage manager — used by `wireAgentListeners` to record per-turn token /
   * cost telemetry on `agent_result`. Shared with the WS path so a system-
   * dispatched turn lands in the same `usage_turns` series as a user-typed
   * turn (cost graph, ContextDial, etc.).
   */
  usageManager: UsageManager;
  /**
   * Optional — push a fresh rate-limit snapshot for any agent (from an
   * `agent_rate_limits` AgentEvent) into the subscription-limits badge.
   * Mirrors the WS-path `AppCtx.recordAgentRateLimits`. Wired by
   * `index.ts` after the limits providers are constructed.
   */
  recordAgentRateLimits?: (
    agentId: AgentId,
    session: { usedPct: number | null; resetAt: string } | null,
    weekly: { usedPct: number | null; resetAt: string } | null,
  ) => void;
  /**
   * Optional — latest subscription-limits snapshot used by the listener to
   * reclassify generic "monthly usage limit" CLI errors into the precise
   * "5h usage limit" message when a session window is exhausted.
   */
  getSubscriptionLimitsSnapshot?: () => SubscriptionLimitsMap;
  /**
   * docs/150 req 7 — bench the session's provider account after the provider
   * fails its turn for quota. Forwarded into the listener so a dispatched /
   * system turn marks exhaustion exactly like a WS turn does.
   */
  markSessionAccountExhausted?: (sessionId: string, until: number, routeId?: string) => void;
  /** planning#358 — see {@link AgentListenerDeps.markCredentialRouteAuthFailed}. */
  markCredentialRouteAuthFailed?: (routeId: string) => void;
  clearCredentialRouteAuthFailed?: (routeId: string) => void;
  /**
   * docs/153 — fire-and-forget nudge to the Claude OAuth refresher. Forwarded
   * into the listener so dispatched/system turns also heal a stale token via
   * the orchestrator-owned refresher when the CLI emits `auth_required`.
   * Mirrors the WS-path `AppCtx.nudgeClaudeOAuthRefresh`. (Most consumers
   * should prefer `onAgentAuthRequired` so the dispatch is keyed by agent.)
   */
  nudgeClaudeOAuthRefresh?: () => void;
  /**
   * docs/155 — per-agent dispatch for the listener's `auth_required` handler.
   * Mirrors the WS-path `AppCtx.onAgentAuthRequired`. Plumbed through here so
   * system-turn listeners get the same routing.
   */
  onAgentAuthRequired?: (agentId: AgentId) => void;
  /**
   * docs/179 — proactively heal an agent's OAuth source token before the
   * dispatched/system turn spawns the CLI. Mirrors the WS-path
   * `AppCtx.ensureAgentTokenFresh`. Plumbed through so quick/child/CI-fix turns
   * get the same pre-spawn heal the WS path does.
   */
  ensureAgentTokenFresh?: (agentId: AgentId, accountId?: string) => Promise<boolean>;
  /**
   * docs/155 Phase 3 — per-agent run-params prep hooks. Forwarded into the
   * system-turn `buildRunParams` so dispatched/CI-fix turns inject the same
   * Claude-only / Codex-only fields the WS path does. Optional; absent in
   * minimal test setups.
   */
  runParamsPreps?: Map<AgentId, PrepareRunParamsFn>;
  /**
   * docs/183 Phase 4b — publish-after-install hook, forwarded into
   * `setupServiceManager`. After a session's `agent.install` resolves, it pulls
   * each declared dep dir's merged snapshot from the worker and publishes it as
   * the next rolling overlay base. Optional; the store is ON by default, so this
   * is inert only when the `OVERLAY_DEP_STORE=0`/`false` kill switch is set or the
   * session is overlay-ineligible; absent in test setups. Constructed
   * in `index.ts` (where `stateDir`/`createRepoGit`/`getBareCacheDir` are in
   * scope) as a runner-adapting wrapper over `publishDepDirOverlayBases`.
   */
  publishOverlayBases?: (args: {
    runner: ContainerSessionRunner;
    session: SessionInfo;
    installOk: boolean;
    installCommands?: string[];
  }) => Promise<DepDirPublishOutcome[]>;
  /**
   * docs/262 — plugin-repository activation, forwarded into
   * `setupServiceManager`. Same construction reason as `publishOverlayBases`:
   * it needs the bare-cache helpers, which live where the app is bootstrapped.
   * Optional; absent in test setups, where no plugin repository is declared.
   */
  activatePluginRepos?: (
    sessionId: string,
    workspaceDir: string,
    onSettled?: (sessionId: string) => void,
  ) => void;
  /** docs/262 — resolve a session's plugin services; forwarded into `setupServiceManager`. */
  resolvePluginServices?: ServiceSetupDeps["resolvePluginServices"];
}

/**
 * Enforce repository trust for ordinary repo-backed sessions. Ops and sandbox
 * sessions are explicit, server-authored execution environments rather than a
 * ShipIt-managed checkout, so the repository messaging gate does not apply.
 */
export function assertSessionCanDispatch(
  sessionId: string,
  session: Pick<SessionInfo, "kind" | "remoteUrl"> | undefined,
  isTrusted: (remoteUrl: string) => boolean,
): void {
  if (!session) throw new AgentTurnAdmissionError(sessionId);
  if (session.kind === "ops" || session.kind === "sandbox") return;
  if (session.remoteUrl && !isTrusted(session.remoteUrl)) {
    throw new AgentTurnAdmissionError(sessionId);
  }
}

/**
 * Create and configure the SessionRunnerRegistry with all callbacks.
 */
export function createRunnerRegistry(
  registryDeps: RunnerRegistryDeps,
): SessionRunnerRegistry {
  const {
    effectiveRunnerFactory, sessionManager, repoStore, createGitManager,
    githubAuthManager, agentFactory, chatHistoryManager,
    autoPushScheduler, sseBroadcast, enforceIdleContainerLimit,
    getDepCacheDir, serviceManagers, composeStopPromises, composeWarnings, composeNotConfigured, containerManager,
    credentialStore, secretStore, dockerSecretsConfig, serviceEnvDir, logStore, runtimeMode, broadcastLog,
    credentialsDir, providerAccountManager, readSystemPrompt, generateText, getPrStatusPoller, rebindDelivery,
    usageManager, recordAgentRateLimits, getSubscriptionLimitsSnapshot,
    markSessionAccountExhausted,
    markCredentialRouteAuthFailed,
    clearCredentialRouteAuthFailed,
    nudgeClaudeOAuthRefresh, onAgentAuthRequired, ensureAgentTokenFresh, runParamsPreps,
    publishOverlayBases,
    activatePluginRepos,
    resolvePluginServices,
  } = registryDeps;

  return new SessionRunnerRegistry({
    ...(effectiveRunnerFactory ? { runnerFactory: effectiveRunnerFactory } : {}),
    depCacheDirResolver: (sessionId: string) => {
      const session = sessionManager.get(sessionId);
      if (session?.remoteUrl) {
        return getDepCacheDir(session.remoteUrl);
      }
      return undefined;
    },
    onRunnerIdle: (sessionId: string) => {
      enforceIdleContainerLimit();
      // docs/146/169 — re-evaluate any session whose remediation state is
      // `deferred` (agent was busy when CI failed / a conflict landed) the
      // moment the agent goes idle, rather than waiting for the next poll.
      // Fans out to BOTH the auto-fix and auto-resolve managers. Cooldown-driven
      // retry still runs through `handleTransition` on the next poll, not here.
      getPrStatusPoller?.()?.notifyRunnerIdle(sessionId);
    },
    onRunnerCreated: (runner) => {
      // planning#246 — the ONE subscriber for the cross-session "busy outside a
      // turn" marker. The runner emits `background_work` from every place its
      // value can change (task list, streaming gate, consult set, dispose), so
      // this is the only site that has to know how the marker reaches a
      // browser — and a new way to clear the tracker needs no broadcast of its
      // own. The previous per-call-site version left five clears silent, each
      // of which pinned a green dot on an idle session until the next reload.
      runner.on("background_work", () => {
        sseBroadcast("session_attention", {
          sessionId: runner.sessionId,
          backgroundTasks: runner.backgroundWorkDescriptions,
        });
        // docs/260 req 13 — a system turn deferred behind background work
        // (the dispatch gate in `dispatchOnRunner`) drains the moment the
        // work clears, rather than waiting for the next user turn. Re-enter
        // through `dispatchOnRunner` so the entry keeps its settlement (the
        // planning#257/planning#261 rule). `systemTurnDeps` is initialized below in
        // this same creation block, before any event can fire.
        if (
          runner.backgroundWorkDescriptions.length === 0
          && !runner.running
          && runner.queueLength > 0
        ) {
          const next = runner.dequeue();
          if (next) {
            runner.emitMessage({ type: "queue_updated", queue: runner.getQueueSnapshot() });
            dispatchOnRunner(runner, systemTurnDeps, queuedMessageToDispatchOptions(next));
          }
        }
      });
      // planning#341 — keep the composer's "start from the latest base" control
      // honest between turns: recompute + push `reset_eligible` when the
      // workspace file watcher reports a change (debounced, merged sessions
      // only). Without it the signal was computed at three moments and never
      // again, so anything that dirtied the tree — a terminal command, a
      // compose service writing to the mounted workspace — left the control
      // painted for an operation the pre-turn gate would then refuse.
      wireResetEligibleOnFileChange(
        {
          getSession: (id) => sessionManager.get(id),
          getPrStatus: (id) => sessionManager.getPrStatus(id),
          createGitManager,
        },
        runner,
      );
      // Shared listener deps — same shape `wireAgentListeners` consumes on
      // the WS path. The system-turn flow now goes through the same listener,
      // so a Fix CI / child-session / `/agent/dispatch` turn produces chat
      // history with the same message-group structure (tool calls visible,
      // assistant text split at tool-result boundaries) as a user-typed turn.
      const listenerDeps = {
        sessionManager,
        chatHistoryManager,
        usageManager,
        sseBroadcast,
        broadcastLog: (source: LogSource, text: string) =>
          broadcastLog(runner.sessionId, source, text),
        // docs/252 phase 8 — the system-turn path reads the row fresh each
        // turn, so this is where a Fix-CI / child-session / dispatched turn on a
        // retired model moves onto its successor (req 13). Resolving at the
        // *source* rather than inside the params build is deliberate: this same
        // reader feeds usage attribution, so normalizing later would record a
        // turn against a model that never ran it (req 11).
        getSelectedModel: () =>
          applyModelRetirement(sessionManager, sessionManager.get(runner.sessionId), runner.agentId),
        getSelectedReasoning: () => sessionManager.get(runner.sessionId)?.reasoningEffort,
        ...(recordAgentRateLimits ? { recordAgentRateLimits } : {}),
        ...(getSubscriptionLimitsSnapshot ? { getSubscriptionLimitsSnapshot } : {}),
        ...(markSessionAccountExhausted ? { markSessionAccountExhausted } : {}),
        ...(markCredentialRouteAuthFailed ? { markCredentialRouteAuthFailed } : {}),
        ...(clearCredentialRouteAuthFailed ? { clearCredentialRouteAuthFailed } : {}),
        ...(nudgeClaudeOAuthRefresh ? { nudgeClaudeOAuthRefresh } : {}),
        ...(onAgentAuthRequired ? { onAgentAuthRequired } : {}),
        // docs/163 — derived voice-note delivery for system turns. Only when a
        // credential store is present (it carries the delivery setting).
        ...(credentialStore
          ? {
              deliverVoiceNote: (
                payload: VoiceNotePayload,
                runner: SessionRunnerInterface,
                source: VoiceNoteSource,
              ) =>
                void routeVoiceNote(payload, {
                  runner,
                  sessionId: runner.sessionId,
                  credentialStore,
                  source,
                  chatHistoryManager,
                }),
            }
          : {}),
      };
      // Shared debounced auto-push for a resolved GitManager. Used by both the
      // `scheduleAutoPush(sessionDir)` dep and the `commitTurn` helper below, so
      // the dispatch path and the shared `postTurnCommit` push identically.
      const schedulePushGit = (git: GitManager): void => {
        autoPushScheduler.schedule(git, runner.sessionId);
      };
      const systemTurnDeps: SystemTurnDeps = {
        authorizeDispatch: (sessionId) => {
          const session = sessionManager.get(sessionId);
          assertSessionCanDispatch(sessionId, session, (remoteUrl) =>
            repoStore.isTrusted(remoteUrl),
          );
        },
        agentFactory: (agentId) => {
          if (runner.createAgent) return runner.createAgent(agentId);
          if (agentFactory) return agentFactory(agentId);
          throw new Error("No agent factory available for system turn");
        },
        // docs/179 — token healer for the runtime-401 auto-retry on system turns.
        ...(ensureAgentTokenFresh ? { ensureAgentTokenFresh } : {}),
        // planning#266 — lets turn adoption re-settle a delivery that survived a restart.
        ...(rebindDelivery ? { rebindDelivery } : {}),
        autoCommit: async (sessionDir, summary) => {
          const git = createGitManager(sessionDir);
          const parentHash = await git.getHeadHash();
          const { commitHash, conflictedFiles, rebaseInProgress, secretFindings, unreadable } =
            await git.autoCommit(summary);
          return { commitHash, parentHash, conflictedFiles, rebaseInProgress, secretFindings, unreadable };
        },
        scheduleAutoPush: (sessionDir) => schedulePushGit(createGitManager(sessionDir)),
        listenerDeps,
        // docs/149 — assemble full AgentRunParams for system turns. Without
        // this, spawned-session / CI-auto-fix turns ran with only
        // `{ prompt, sessionId, cwd }` (no system prompt, no settings, no
        // model, no MCP, no autoCreatePr). When `credentialStore` is absent
        // (extreme-minimal test setup) we fall back to the minimal shape
        // so we don't regress those callers.
        buildRunParams: async (sessionId, agentId, prompt, turnRoute) => {
          const session = sessionManager.get(sessionId);
          if (!credentialStore) {
            return {
              prompt,
              cwd: runner.sessionDir,
              ...(session?.agentSessionId !== undefined ? { sessionId: session.agentSessionId } : {}),
            };
          }
          return buildAgentRunParams({
            deps: {
              credentialStore,
              githubAuthManager,
              sessionManager,
              readSystemPrompt: readSystemPrompt ?? (() => Promise.resolve(undefined)),
              getSelectedModel: () => applyModelRetirement(sessionManager, session, agentId),
              getSelectedReasoning: () => session?.reasoningEffort,
              ...(runParamsPreps ? { runParamsPreps } : {}),
            },
            sessionId,
            agentId,
            prompt,
            ...(turnRoute ? { turnRoute } : {}),
            sessionDir: runner.sessionDir,
            ...(session?.agentSessionId !== undefined ? { agentSessionId: session.agentSessionId } : {}),
          });
        },
        // docs/149 — write back any CLI-rotated OAuth token after a system
        // turn lands. Mirrors the WS-path `syncTokenBackAfterTurn` discipline.
        ...(credentialsDir && credentialStore ? {
          finalizeAgentEnv: (sessionId, agentId, capturedRoute) => {
            finalizeSessionAgentEnvironment(runner, {
              sessionId,
              agentId,
              ...(capturedRoute ? { capturedRoute } : {}),
              deps: { credentialsDir, credentialStore, sessionManager },
            });
          },
          // docs/179 — the runtime-401 recovery's unconditional token push, at
          // parity with the WS path. Only the recovery path calls it.
          repushSessionAgentToken: (sessionId, agentId) => {
            repushSessionAgentToken(runner, {
              sessionId,
              agentId,
              deps: { credentialsDir, sessionManager },
            });
          },
          // Re-sync the freshest OAuth token immediately before spawn, the same
          // late moment the WS path does. Closes the staleness window that let a
          // quick/child/CI-fix turn spawn with a sibling-rotated (dead) token →
          // "Not logged in". Idempotent with the service fn's earlier call.
          prepareAgentEnv: async (sessionId, agentId, envOpts) => {
            return prepareSessionAgentEnvironment(runner, {
              sessionId,
              agentId,
              // docs/150 req 13 — the dispatched/system-turn twin of the WS
              // path's preflight, so a child, CI-fix, or wake turn is blocked
              // by an exhausted provider exactly like a user-typed one.
              enforceAccountRouting: true,
              // A dispatched turn reuses the resident streaming process too
              // (`dispatched-turn.ts` captures it), so it needs the same
              // no-repair-under-a-live-CLI guarantee as the WS path.
              ...(envOpts?.reusingResidentAgent ? { reusingResidentAgent: true } : {}),
              ...(envOpts?.excludeRouteIds ? { excludeRouteIds: envOpts.excludeRouteIds } : {}),
              ...(envOpts?.residentRoute ? { residentRoute: envOpts.residentRoute } : {}),
              ...(envOpts?.requireResidentRoute ? { requireResidentRoute: true } : {}),
              deps: {
                credentialsDir, credentialStore, sessionManager, chatHistoryManager,
                ...(providerAccountManager ? { providerAccountManager } : {}),
                ...(ensureAgentTokenFresh ? { ensureAgentTokenFresh } : {}),
              },
            });
          },
          // docs/260 §5 — post-restart resident identity. The resident-route
          // record (written at every routed spawn) is authoritative — it is
          // the only identity a string/env-delivered credential leaves behind
          // (reqs 11/13). The account marker is the fallback for processes
          // spawned before the record existed.
          ...(credentialsDir ? {
            recoverResidentRoute: (sessionId: string, agentId: AgentId) => {
              const recorded = readSessionResidentRoute(credentialsDir, sessionId)[agentId];
              if (recorded) return recorded;
              const marked = readSessionAccountMarker(credentialsDir, sessionId)[agentId];
              return marked !== undefined ? { kind: "account" as const, id: marked } : undefined;
            },
          } : {}),
          // docs/260 req 10 — labels for the attempt-loop notices.
          routeLabel: (routeId: string) =>
            providerAccountManager?.getByRouteId(routeId)?.label
            ?? credentialStore.getCredentialRoute(routeId)?.label,
          // docs/260 req 2 — billing mode + service of the turn's captured
          // route, so failure policy never re-reads the session row.
          routeProfile: (kind: ProviderRouteKind, routeId: string) => {
            const row = providerAccountManager?.getByRouteId(routeId)
              ?? credentialStore.getCredentialRoute(routeId);
            if (row) return { billingMode: row.billingMode, serviceId: row.serviceId };
            const mode = billingModeForRoute(kind, routeId);
            return mode ? { billingMode: mode } : undefined;
          },
          // docs/260 — the dispatched-turn twin of the WS pre-capture check:
          // release the resident process only when selection would land this
          // turn on a DIFFERENT credential, and never while the process holds
          // background work (req 13 — the check itself answers false then).
          needsAccountFailover: (sessionId: string) =>
            residentRouteNeedsRelease(sessionManager.get(sessionId), runner.agentId, runner, {
              credentialStore,
              ...(providerAccountManager ? { providerAccountManager } : {}),
            }),
        } : {}),
        // Single shared commit helper — same `postTurnCommit` the WS path uses
        // (workspace-locked auto-commit + conflict notice + auto-push + commit
        // link). The dispatch path routes through this instead of its inline
        // commit block so both transports commit identically.
        commitTurn: ({ sessionDir, sessionId, summary, turnStartHeadHash, runner: turnRunner, emit }) =>
          postTurnCommit(
            {
              createGitManager,
              chatHistoryManager,
              sessionManager,
              scheduleAutoPush: (git) => schedulePushGit(git),
            },
            { sessionDir, sessionId, emit, turnSummary: summary, turnStartHeadHash, runner: turnRunner },
          ),
        // docs/163 — resolve the live steer-or-queue gate for the dispatch
        // path so a programmatic message arriving mid-turn (`shipit session
        // message`, CI-fix, quick session) is injected into a steerable
        // streaming turn instead of always being queued. `liveSteering` is the
        // live user setting; `steeringCapable` is the runner's pinned agent's
        // static `supportsSteering` capability (read fresh because `agentId`
        // can change). Mirrors the WS handler's gate.
        steerInputs: () => ({
          liveSteering: credentialStore?.getLiveSteering() ?? false,
          steeringCapable: getAgentCapabilities(runner.agentId)?.supportsSteering ?? false,
        }),
        // docs/218 + planning#333 — pre-turn auto-reset of a merged session's branch
        // onto the latest base, for turns that arrive programmatically: an Agent
        // Interface SDK message from a page the agent built, `shipit session
        // message`, a notify-on-merge wake, a Create-PR button. The interactive
        // path wires the same helper in `agent-execution.ts`; both go through
        // `applyPreTurnReset` so the two transports can't drift.
        //
        // Same lazy poller resolution as `postTurnReArmReset` below. Skipped
        // when the poller or credential store is absent (minimal test wiring) —
        // the reset needs the merged PR's base branch and the global setting.
        preTurnReset: async (runner, sessionId, sessionDir) => {
          const prStatusPoller = getPrStatusPoller?.();
          if (!prStatusPoller || !credentialStore) return { agentPrefix: "" };
          return await applyPreTurnReset({
            deps: {
              sessionManager,
              prStatusPoller,
              createGitManager,
              sseBroadcast,
              chatHistoryManager,
              getAutoResetMergedBranch: () => credentialStore.getAutoResetMergedBranch(),
            },
            runner,
            sessionId,
            sessionDir,
          });
        },
        // docs/221 / nikzlabs/shipit#2349 — deliver the parked "your tree was
        // rewritten" notice on this transport too. A message queued while a sync
        // settles is released onto `dispatch`, so the interactive-only consume
        // dropped it for exactly the turn most likely to need it.
        consumePendingAgentNotice: (sessionId) => sessionManager.consumePendingAgentNotice(sessionId),
        // nikzlabs/shipit#2350 — a dispatched NON-system turn is the user speaking (an
        // SDK click, a `shipit session message`), so it carries a resolved
        // bug-report card's outcome exactly as a typed turn does.
        consumeBugOutcomes: (sessionId) => chatHistoryManager.consumeUnreportedBugOutcomes(sessionId),
        // ...and put it back if that turn never reached the agent, so a spawn
        // failure can't burn the only warning that the tree was rewritten.
        restorePendingAgentNotice: (sessionId, notice) => sessionManager.setPendingAgentNotice(sessionId, notice),
        // docs/149 — emit the PR lifecycle card after a system-turn commit.
        // Lazy poller resolution because the poller is constructed AFTER the
        // runner registry; the closure fires post-turn, by which time it's set.
        ...(generateText ? {
          postTurnPrFlow: async (sessionId, sessionDir, commitHash, emit) => {
            const prStatusPoller = getPrStatusPoller?.();
            if (!prStatusPoller || !credentialStore) return;
            // docs/202 — re-arm a merged+rebased session before the card emit,
            // so spawned/CI/programmatic turns re-arm too (not just the WS path).
            await detectAndReArmMergedSession({
              deps: { sessionManager, prStatusPoller, createGitManager, sseBroadcast },
              sessionId,
              sessionDir,
            });
            await emitPrLifecycleAfterCommit({
              deps: {
                sessionManager,
                prStatusPoller,
                githubAuthManager,
                credentialStore,
                chatHistoryManager,
                generateText,
                createGitManager,
              },
              sessionId,
              sessionDir,
              commitHash,
              emit,
            });
          },
          // docs/216 — re-arm a merged session whose branch was reset to a clean
          // base. Fires on EVERY turn (commit or not) so spawned/CI/programmatic
          // turns clear a stale merged card after a reset, not just the WS path.
          postTurnReArmReset: async (sessionId, sessionDir, emit) => {
            const prStatusPoller = getPrStatusPoller?.();
            if (!prStatusPoller) return;
            await detectAndReArmResetSession({
              deps: { sessionManager, prStatusPoller, createGitManager, sseBroadcast },
              sessionId,
              sessionDir,
              emit,
            });
            // docs/218 + planning#333 — recompute + push the composer's
            // reset-eligibility signal after every turn, the same way the WS
            // adapter does. Without it this path was write-only: only a turn
            // that MOVED the branch emitted `false` (from the pre-turn hook), so
            // a dispatched turn that skipped the reset and then committed — or
            // one that left the tree dirty — never corrected an `eligible: true`
            // pushed at activation, and the composer kept offering a reset the
            // server would refuse. Safety-only; the client ANDs the global
            // setting. Best-effort — never blocks the post-turn flow.
            try {
              await emitResetEligible(
                {
                  getSession: (id) => sessionManager.get(id),
                  getPrStatus: (id) => sessionManager.getPrStatus(id),
                  createGitManager,
                },
                { sessionId, sessionDir, origin: "post-turn", emit },
              );
            } catch (err) {
              console.error(`[pre-turn-reset] post-turn eligibility signal failed for ${sessionId}:`, err);
            }
          },
        } : {}),
      };
      runner.setSystemTurnDeps(systemTurnDeps);

      // In local mode (dogfooding), the orchestrator can't manage Docker —
      // skip ServiceManager wiring entirely for inner sessions. This also
      // suppresses the noisy `compose_not_configured` event the inner UI
      // would otherwise see on every session creation. Inner-session
      // preview is deferred to Phase 2.
      if (runtimeMode !== "local") {
        // Set up compose ServiceManager if the session has a compose config
        const setupDeps = {
          sessionManager,
          repoStore,
          serviceManagers,
          composeStopPromises,
          composeWarnings,
          composeNotConfigured,
          containerManager,
          secretStore,
          dockerSecretsConfig,
          serviceEnvDir,
          logStore,
          broadcastLog,
          credentialStore,
          publishOverlayBases,
          activatePluginRepos,
          resolvePluginServices,
        };
        setupServiceManager(runner, setupDeps);

        // Re-evaluate the session's config when it changes on disk — an edit
        // the file watcher reports, or an orchestrator-side workspace rewrite
        // (rebase/sync) that calls `runner.reevaluateWorkspaceConfig()`.
        // `applyShipitConfigChange` handles the full delta, including the
        // no-manager-yet case (which delegates back to `setupServiceManager`).
        if ("onComposeConfigChanged" in runner) {
          (runner as { onComposeConfigChanged?: () => void }).onComposeConfigChanged = () => {
            applyShipitConfigChange(runner, setupDeps);
          };
        }

        // docs/178 — re-run setup when the user trusts a previously-untrusted
        // remote. The trust endpoint invokes this so the deferred install +
        // compose stack start for the already-open session.
        if ("rerunServiceSetup" in runner) {
          (runner as { rerunServiceSetup?: () => void }).rerunServiceSetup = () => {
            setupServiceManager(runner, setupDeps);
          };
        }
      } else if (activatePluginRepos) {
        // docs/262 — local mode has no ServiceManager, but plugin repositories
        // are not a compose feature: checkout, generations, and refresh are
        // exactly what plan §5 asks the inner dogfood instance to exercise, and
        // gating them behind the Docker path skipped them there entirely
        // (review finding). Only compose services can't run locally.
        //
        // The trust gate is re-applied here rather than inherited, since this
        // path does not run `setupServiceManager`.
        const activateIfTrusted = () => {
          const session = sessionManager.get(runner.sessionId);
          const workspaceDir = session?.workspaceDir ?? runner.sessionDir;
          const remoteUrl = session?.remoteUrl;
          if (remoteUrl && !repoStore.isTrusted(remoteUrl)) return;
          // Local mode holds no ServiceManager, so the services half of the
          // hook is inert here by construction rather than by omission.
          activatePluginRepos(
            runner.sessionId,
            workspaceDir,
            emitPluginReposUpdated(runner, { sessionManager, serviceManagers }),
          );
        };
        activateIfTrusted();
        runner.on("disposed", () => clearActivationState(runner.sessionId));
        // The container path re-activates on `onComposeConfigChanged`, which
        // `reevaluateWorkspaceConfig` fires — both are ContainerSessionRunner
        // only, and local mode has no in-container file watcher to drive them
        // (third-review finding). A turn ending is the local signal that files
        // may have changed: in local mode the agent IS the only editor, and
        // re-activation is a cheap no-op when the resolved commit is unchanged.
        runner.on("idle", activateIfTrusted);
        // Assigned unconditionally, not behind an `in` guard: the trust
        // endpoint reads this property off the runner instance, and the local
        // runner class doesn't declare it — so the guard silently skipped it
        // and accepting trust left an open local session inactive.
        (runner as { rerunServiceSetup?: () => void }).rerunServiceSetup = activateIfTrusted;
      }
    },
  });
}
