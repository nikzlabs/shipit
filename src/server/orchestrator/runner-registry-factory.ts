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
import { emitNoticeInTurn } from "./chat-card-persistence.js";
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
import { shouldCompactBeforeTurn } from "./compact-before-turn.js";
import { emitResetEligible } from "./services/pre-turn-reset.js";
import { wireResetEligibleOnFileChange } from "./reset-eligible-watch.js";
import { postTurnCommit } from "./ws-handlers/post-turn.js";
import { takeRoleStandingInstructions } from "./services/session-role.js";
import { routeVoiceNote } from "./voice/voice-note-router.js";
import type { VoiceNotePayload, VoiceNoteSource } from "../shared/types/voice-note-types.js";
import { getAgentCapabilities } from "../shared/agent-registry.js";
import { residentRouteNeedsRelease} from "./service-routing.js";
import type { GenerateText } from "./non-turn-model.js";

export interface RunnerRegistryDeps {
  effectiveRunnerFactory: SessionRunnerFactory | undefined;
  sessionManager: SessionManager;
  repoStore: RepoStore;
  createGitManager: (dir: string) => GitManager;
  githubAuthManager: GitHubAuthManager;
  agentFactory: ((agentId: AgentId) => AgentProcess) | undefined;
  chatHistoryManager: ChatHistoryManager;
  autoPushScheduler: AutoPushScheduler;
  sseBroadcast: (event: string, data: unknown) => void;
  enforceIdleContainerLimit: () => void;
  getDepCacheDir: (repoUrl: string) => string;
  serviceManagers: Map<string, ServiceManager>;
  /** New setup must await the previous stop: both use the same Compose project. */
  composeStopPromises: Map<string, Promise<void>>;
  composeWarnings: Map<string, string>;
  composeNotConfigured: Set<string>;
  containerManager: SessionContainerManager | null;
  credentialStore?: CredentialStore;
  secretStore?: SecretStore;
  dockerSecretsConfig?: {
    internalDir: string;
    hostDir?: string;
    entrypointSourcePath: string;
  };
  /** Orchestrator-private directory outside the agent's workspace mount. */
  serviceEnvDir: string;
  logStore?: LogStore;
  runtimeMode: RuntimeMode;
  broadcastLog: (sessionId: string, source: LogSource, text: string) => void;
  credentialsDir?: string;
  providerAccountManager?: ProviderAccountManager;
  readSystemPrompt?: () => Promise<string | undefined>;
  generateText?: GenerateText;
  /** Lazy because the poller depends on this registry and is constructed later. */
  getPrStatusPoller?: () => PrStatusPoller | undefined;
  reconcileAgentMergeClaimsFor?: (sessionId: string) => void;
  isAgentMergeInFlight?: (sessionId: string) => boolean;
  getAutoConflictResolveManager?: () => AutoConflictResolveManager | undefined;
  /** Rebind a worker's adopted turn to its original delivery after restart. */
  rebindDelivery?: (deliveryId: string) => ((outcome: TurnOutcome) => void) | undefined;
  usageManager: UsageManager;
  recordAgentRateLimits?: (
    agentId: AgentId,
    session: { usedPct: number | null; resetAt: string } | null,
    weekly: { usedPct: number | null; resetAt: string } | null,
  ) => void;
  getSubscriptionLimitsSnapshot?: () => SubscriptionLimitsMap;
  markSessionAccountExhausted?: (sessionId: string, until: number, routeId?: string) => void;
  markCredentialRouteAuthFailed?: (routeId: string) => void;
  clearCredentialRouteAuthFailed?: (routeId: string) => void;
  nudgeClaudeOAuthRefresh?: () => void;
  onAgentAuthRequired?: (agentId: AgentId) => void;
  ensureAgentTokenFresh?: (agentId: AgentId, accountId?: string) => Promise<boolean>;
  runParamsPreps?: Map<AgentId, PrepareRunParamsFn>;
  publishOverlayBases?: (args: {
    runner: ContainerSessionRunner;
    session: SessionInfo;
    installOk: boolean;
    installCommands?: string[];
  }) => Promise<DepDirPublishOutcome[]>;
  activatePluginRepos?: (
    sessionId: string,
    workspaceDir: string,
    onSettled?: (sessionId: string) => void,
  ) => void;
  resolvePluginServices?: ServiceSetupDeps["resolvePluginServices"];
}

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
    reconcileAgentMergeClaimsFor,
    isAgentMergeInFlight,
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
      getPrStatusPoller?.()?.notifyRunnerIdle(sessionId);
      reconcileAgentMergeClaimsFor?.(sessionId);
    },
    onRunnerCreated: (runner) => {
      // A merge can start before this runner exists; seed both dispatch and disposal holds.
      if (isAgentMergeInFlight?.(runner.sessionId)) {
        runner.mergeHold = true;
        runner.beginPostTurnWork();
      }
      runner.on("background_work", () => {
        sseBroadcast("session_attention", {
          sessionId: runner.sessionId,
          backgroundTasks: runner.backgroundWorkDescriptions,
        });
        // Re-enter dispatch to preserve the queued entry's settlement callback.
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
      wireResetEligibleOnFileChange(
        {
          getSession: (id) => sessionManager.get(id),
          getPrStatus: (id) => sessionManager.getPrStatus(id),
          createGitManager,
        },
        runner,
      );
      const listenerDeps = {
        sessionManager,
        chatHistoryManager,
        usageManager,
        sseBroadcast,
        broadcastLog: (source: LogSource, text: string) =>
          broadcastLog(runner.sessionId, source, text),
        // Resolve retirement here so spawn parameters and usage attribution agree.
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
        ...(ensureAgentTokenFresh ? { ensureAgentTokenFresh } : {}),
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
        buildRunParams: async (sessionId, agentId, prompt, turnRoute, runParamOpts) => {
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
            ...(runParamOpts?.compact ? { compact: true } : {}),
          });
        },
        ...(credentialsDir && credentialStore ? {
          finalizeAgentEnv: (sessionId, agentId, capturedRoute) => {
            finalizeSessionAgentEnvironment(runner, {
              sessionId,
              agentId,
              ...(capturedRoute ? { capturedRoute } : {}),
              deps: { credentialsDir, credentialStore, sessionManager },
            });
          },
          repushSessionAgentToken: (sessionId, agentId) => {
            repushSessionAgentToken(runner, {
              sessionId,
              agentId,
              deps: { credentialsDir, sessionManager },
            });
          },
          prepareAgentEnv: async (sessionId, agentId, envOpts) => {
            return prepareSessionAgentEnvironment(runner, {
              sessionId,
              agentId,
              enforceAccountRouting: true,
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
          // Older spawns have only an account marker; string credentials require the route record.
          ...(credentialsDir ? {
            recoverResidentRoute: (sessionId: string, agentId: AgentId) => {
              const recorded = readSessionResidentRoute(credentialsDir, sessionId)[agentId];
              if (recorded) return recorded;
              const marked = readSessionAccountMarker(credentialsDir, sessionId)[agentId];
              return marked !== undefined ? { kind: "account" as const, id: marked } : undefined;
            },
          } : {}),
          routeLabel: (routeId: string) =>
            providerAccountManager?.getByRouteId(routeId)?.label
            ?? credentialStore.getCredentialRoute(routeId)?.label,
          routeProfile: (kind: ProviderRouteKind, routeId: string) => {
            const row = providerAccountManager?.getByRouteId(routeId)
              ?? credentialStore.getCredentialRoute(routeId);
            if (row) return { billingMode: row.billingMode, serviceId: row.serviceId };
            const mode = billingModeForRoute(kind, routeId);
            return mode ? { billingMode: mode } : undefined;
          },
          needsAccountFailover: (sessionId: string) =>
            residentRouteNeedsRelease(sessionManager.get(sessionId), runner.agentId, runner, {
              credentialStore,
              ...(providerAccountManager ? { providerAccountManager } : {}),
            }),
        } : {}),
        commitTurn: ({ sessionDir, sessionId, summary, turnStartHeadHash, runner: turnRunner, emit, deferPushArm }) =>
          postTurnCommit(
            {
              createGitManager,
              chatHistoryManager,
              sessionManager,
              scheduleAutoPush: (git) => schedulePushGit(git),
            },
            {
              sessionDir, sessionId, emit, turnSummary: summary, turnStartHeadHash, runner: turnRunner,
              ...(deferPushArm ? { deferPushArm } : {}),
            },
          ),
        steerInputs: () => ({
          liveSteering: credentialStore?.getLiveSteering() ?? false,
          steeringCapable: getAgentCapabilities(runner.agentId)?.supportsSteering ?? false,
        }),
        preTurnReset: async (runner, sessionId, sessionDir, intent) => {
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
            ...(intent !== undefined ? { intent } : {}),
          });
        },
        shouldCompactBeforeTurn: async (runner, agentId, sessionId, sessionDir, intent) => {
          if (!credentialStore) return false;
          const prStatusPoller = getPrStatusPoller?.();
          return await shouldCompactBeforeTurn({
            deps: {
              getSession: (id) => sessionManager.get(id),
              getPrStatus: (id) => sessionManager.getPrStatus(id),
              createGitManager,
              getAutoResetMergedBranch: () => credentialStore.getAutoResetMergedBranch(),
              ...(prStatusPoller
                ? {
                    mergeRecheckDeps: {
                      verifyPrState: (id: string) =>
                        prStatusPoller.forceVerifySessionPrState(id, { armAbsentDebounce: false }),
                      awaitMergeHandling: (id: string) => prStatusPoller.awaitMergeHandling(id),
                    },
                  }
                : {}),
            },
            runner,
            agentId,
            sessionId,
            sessionDir,
            ...(intent !== undefined ? { intent } : {}),
          });
        },
        consumePendingAgentNotice: (sessionId) => sessionManager.consumePendingAgentNotice(sessionId),
        consumeBugOutcomes: (sessionId) => chatHistoryManager.consumeUnreportedBugOutcomes(sessionId),
        ...(credentialStore
          ? { takeRoleInstructions: (sessionId: string) =>
              takeRoleStandingInstructions(sessionId, { sessionManager, credentialStore }) }
          : {}),
        restorePendingAgentNotice: (sessionId, notice) => sessionManager.setPendingAgentNotice(sessionId, notice),
        ...(generateText ? {
          postTurnPrFlow: async (sessionId, sessionDir, commitHash, emit) => {
            const prStatusPoller = getPrStatusPoller?.();
            if (!prStatusPoller || !credentialStore) return;
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
          postTurnReArmReset: async (sessionId, sessionDir, emit) => {
            const prStatusPoller = getPrStatusPoller?.();
            if (!prStatusPoller) return;
            await detectAndReArmResetSession({
              deps: { sessionManager, prStatusPoller, createGitManager, sseBroadcast },
              sessionId,
              sessionDir,
              emit,
            });
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

      // Local mode has no Docker daemon for Compose.
      if (runtimeMode !== "local") {
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

        if ("onComposeConfigChanged" in runner) {
          (runner as { onComposeConfigChanged?: () => void }).onComposeConfigChanged = () => {
            applyShipitConfigChange(runner, setupDeps);
          };
        }

        if ("rerunServiceSetup" in runner) {
          (runner as { rerunServiceSetup?: () => void }).rerunServiceSetup = () => {
            setupServiceManager(runner, setupDeps);
          };
        }

        if ("onDependenciesUnverified" in runner) {
          (runner as { onDependenciesUnverified?: (message: string) => void })
            .onDependenciesUnverified = (message: string) => {
              emitNoticeInTurn(runner, runner.sessionId, message, chatHistoryManager, "warn");
            };
        }
      } else if (activatePluginRepos) {
        // This path bypasses setupServiceManager, so it needs its own trust check.
        const activateIfTrusted = () => {
          const session = sessionManager.get(runner.sessionId);
          const workspaceDir = session?.workspaceDir ?? runner.sessionDir;
          const remoteUrl = session?.remoteUrl;
          if (remoteUrl && !repoStore.isTrusted(remoteUrl)) return;
          activatePluginRepos(
            runner.sessionId,
            workspaceDir,
            emitPluginReposUpdated(runner, { sessionManager, serviceManagers }),
          );
        };
        activateIfTrusted();
        runner.on("disposed", () => clearActivationState(runner.sessionId));
        // Local runners lack the container file watcher; check after each turn.
        runner.on("idle", activateIfTrusted);
        // The local runner does not declare this property, so an `in` guard would skip it.
        (runner as { rerunServiceSetup?: () => void }).rerunServiceSetup = activateIfTrusted;
      }
    },
  });
}
