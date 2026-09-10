import fs from "node:fs";
import { perSessionCredentialsDir } from "./session-credentials-scaffold.js";
import { restoreOpenCodeAccount } from "./openai-account-delivery.js";
import { accountOwnerHarness } from "./provider-account-manager.js";
import { AgentMergeClaimStore } from "./agent-merge-claims.js";
import { reconcileAgentMergeClaims } from "./services/agent-merge-settlement.js";
import { AgentMergeExecutor } from "./services/agent-merge-executor.js";
import { serviceForLoginIntegration } from "../shared/catalogue/index.js";
import path from "node:path";
import { createDockerClient } from "./docker-client.js";
import type { AgentId, DockerMemoryStats } from "../shared/types.js";
import type { SessionInfo } from "../shared/types.js";
import { readGlobalSystemPrompt } from "./global-system-prompt.js";
import { LogStore } from "./log-store.js";
import type { PrStatusPoller } from "./pr-status-poller.js";
import { ReleaseStatusPoller } from "./release-status-poller.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import { sessionHasLiveAgent } from "./session-runner.js";
import { releaseQueuedTurn } from "./queue-drain.js";
import type { ServiceManager } from "./service-manager.js";
import type { ResolvedEgressConfig } from "./egress-allowlist.js";
import type { AppCtx } from "./ws-handlers/types.js";
import type { AppDeps } from "./app-di.js";
import type { ManagerSet } from "./app-di.js";
import { buildAgentRuntime } from "./agents/index.js";
import { LimitsRegistry } from "./limits-registry.js";
import { ZaiLimitsProvider, ZAI_SERVICE_ID } from "./limits/zai-limits-provider.js";
import { XaiLimitsProvider, XAI_SERVICE_ID } from "./limits/xai-limits-provider.js";
import { limitsModeKey } from "../shared/types/usage-limits-types.js";
import { credentialOwnerForRouteId } from "./service-routing.js";
import { accountServiceForHarness } from "./provider-account-manager.js";
import {
  setupContainerManager,
  buildRunnerFactory,
  createIdleEnforcer,
  createRunnerRegistry,
  createSSE,
  createPrStatusPoller,
  createLogBuffer,
  wireEventHandlers,
  markProviderAccountUnauthenticated,
  markProviderAccountReauthenticated,
  createSessionDirFactory,
  createBareCacheDirHelper,
  bareCacheRoot,
  depCacheRoot,
  createDepCacheDirHelper,
  createWarmPool,
  createWarmPreviewStarter,
  runRepoMigration,
  runRemoteCredentialScrub,
  retireWarmSessions,
  scheduleStartupTasks,
} from "./app-lifecycle.js";
import { refreshAllRepoDefaultBranches } from "./services/repo-default-branch.js";
import { repoMemoryDir } from "./repo-memory-manager.js";
import { restoreSessionWorkspace } from "./services/session.js";
import { reattachInFlightTurns } from "./restart-turn-reattach.js";
import { reconcileOrphanedConsultCards } from "./consult-card-reconcile.js";
import { createOomCircuitBreaker } from "./oom-circuit-breaker.js";
import { MergeWatchManager } from "./merge-watch.js";
import { createSessionLoopDetector } from "./loop-detector.js";
import { createRepoPrefetcher, type RepoPrefetcher } from "./repo-prefetch.js";
import { pruneSessionVolumes } from "./disk-janitor.js";
import { isOverlayEligible, isOverlayEnabled } from "./overlay-session.js";
import { publishDepDirOverlayBases, type DepDirPublishOutcome } from "./overlay-publish.js";
import type { ContainerSessionRunner } from "./container-session-runner.js";
import { ClaudeOAuthRefresher } from "./agents/claude/oauth-refresher.js";
import { CodexOAuthRefresher } from "./agents/codex/oauth-refresher.js";
import { repushAgentToken, repushProviderAccountToken,
  readSessionAccountMarker,
} from "./session-credentials.js";
import { MarketplaceStore } from "./marketplace-store.js";
import type { UpdateMode } from "./services/updates.js";
import type { VersionInfo } from "../shared/types.js";
import type { GenerateText } from "./non-turn-model.js";
import { makeNonTurnGenerateText } from "./services/non-turn-work.js";
import { createAutoPushScheduler } from "./services/auto-push-scheduler.js";
import { listCredentialRoutes as listCredentialRoutesForWire } from "./services/credential-routes.js";
import { activateDeclaredPlugins, type PluginInstallHook } from "./services/plugin-activation.js";
import { refreshPluginRepos, type PluginRefreshResult } from "./services/plugin-refresh.js";
import { resolveSessionPluginServices } from "./services/plugin-services.js";
import { createStagedGenerationGate } from "./services/plugin-preflight.js";
import type { PluginComposeService } from "./plugin-compose.js";
import { emitPluginReposUpdated, trackComposeStop } from "./service-manager-setup.js";
import { createPluginInstallRunner, PLUGIN_INSTALL_NETWORK } from "./plugin-install.js";
import { registerExistingPluginNetworks } from "./plugin-container.js";
import { createGenerationDeletionLease } from "./plugin-leases.js";
import {
  runPluginCommand, PLUGIN_CLI_NETWORK, type PluginCliRequest, type PluginCliResult,
} from "./plugin-cli-run.js";
import { sessionStateDirForWorkspace } from "./session-state-dir.js";
import { pinStorePath } from "./plugin-pins.js";
import { createPluginRepoFetcher } from "./plugin-fetch.js";

export interface BootstrapMeta {
  processStartedAt: number;
  buildId: string | undefined;
  version: VersionInfo;
  updateMode: UpdateMode;
  clientDir: string;
}

export interface BootstrapManagersDeps {
  deps: AppDeps;
  mgrs: ManagerSet;
  resolveEgressConfig: (sessionId: string) => ResolvedEgressConfig;
  meta: BootstrapMeta;
}

export async function bootstrapManagers(args: BootstrapManagersDeps) {
  const { deps, mgrs, resolveEgressConfig, meta } = args;
  const {
    defaultAgentId, workspaceDir, stateDir, credentialsDir, shouldServeStatic,
    autoPushDebounceMs, sessionsRoot, agentFactory, localAgentFactory,
    createGitManager, createRepoGit, databaseManager, sessionManager,
    repoStore, chatHistoryManager, usageManager, authManager, codexAuthManager,
    xaiAuthManager,
    credentialStore, providerAccountManager, agentRegistry, githubAuthManager,
    secretStore, reviewStore, egressAllowlistStore, presentStore, generateText,
    isTestMode, runtimeMode,
  } = mgrs;

  // Retire rows before discovery so old standbys cannot be adopted again.
  await retireWarmSessions({
    repoStore, sessionManager, chatHistoryManager, usageManager, presentStore,
  });

  const { containerManager, dockerProxyServer } = await setupContainerManager({
    deps, isTestMode, credentialsDir, stateDir, sessionManager, runtimeMode, resolveEgressConfig,
  });

  // Restore untrusted network identities before requests can mistake plugin callers for browsers.
  if (containerManager) {
    await registerExistingPluginNetworks(
      containerManager.dockerClient,
      [PLUGIN_CLI_NETWORK, PLUGIN_INSTALL_NETWORK],
    );
  }

  const dockerForStats = containerManager ? createDockerClient() : null;

  const getBareCacheDir = createBareCacheDirHelper(stateDir);
  const getDepCacheDir = createDepCacheDirHelper(stateDir);

  const marketplaceStore = new MarketplaceStore(databaseManager);
  marketplaceStore.seedIfMissing({
    id: "claude-plugins-official",
    source: { kind: "github", ownerRepo: "anthropics/claude-plugins-official" },
    agentId: "claude",
    autoUpdate: true,
  });
  marketplaceStore.seedIfMissing({
    id: "openai-curated",
    source: { kind: "github", ownerRepo: "openai/plugins" },
    agentId: "codex",
    autoUpdate: true,
  });

  const { sseClients, sseBroadcast } = createSSE();

  const logStore = new LogStore(sessionsRoot);
  const { getLogBuffer, clearLogBuffer, removeLogBuffer, broadcastLog } = createLogBuffer(logStore);
  const removeSessionLogs = (sid: string): void => {
    logStore.remove(sid);
    removeLogBuffer(sid);
  };

  const oomBreaker = createOomCircuitBreaker();

  const loopDetector = createSessionLoopDetector();

  const effectiveRunnerFactory = buildRunnerFactory({
    deps, containerManager, credentialsDir, sessionManager, runtimeMode, broadcastLog,
    oomBreaker, presentStore, chatHistoryManager, credentialStore,
    ...(localAgentFactory ? { localAgentFactory } : {}),
    providerAccountManager,
  });

  const serviceManagers = new Map<string, ServiceManager>();
  const composeStopPromises = new Map<string, Promise<void>>();
  const composeWarnings = new Map<string, string>();
  const composeNotConfigured = new Set<string>();

  const announcePreviewsStopped = (sessionId: string): void => {
    sseBroadcast("session_previews_stopped", { sessionId });
  };

  containerManager?.on("container_destroyed", (sessionId, previewsStopped) => {
    if (previewsStopped) announcePreviewsStopped(sessionId);
  });

  const latestMemoryStats: { value: DockerMemoryStats | null } = { value: null };

  const registryHolder: { ref: SessionRunnerRegistry | null } = { ref: null };
  // Reuse the enforcer: its state prevents repeated reclaim against a stale memory reading.
  let idleEnforcer: (() => void) | null = null;
  const enforceIdleContainerLimit = () => {
    if (!registryHolder.ref) return;
    idleEnforcer ??= createIdleEnforcer({
      containerManager,
      runnerRegistry: registryHolder.ref,
      sessionManager,
      getMemoryStats: () => latestMemoryStats.value,
      services: {
        liveSessions: () => [...serviceManagers.keys()],
        has: (sessionId) => serviceManagers.has(sessionId),
        stop: (sessionId) => {
          const mgr = serviceManagers.get(sessionId);
          if (!mgr) return;
          serviceManagers.delete(sessionId);
          // Drop browser iframes only after Compose stops successfully.
          trackComposeStop(composeStopPromises, sessionId, mgr, {
            onStopped: () => announcePreviewsStopped(sessionId),
          });
        },
      },
      sseBroadcast,
      broadcastLog,
    });
    idleEnforcer();
  };

  const effectiveGenerateText: GenerateText = deps.generateText ?? makeNonTurnGenerateText({
    credentialStore,
    providerAccountManager,
    getRunnerRegistry: () => registryHolder.ref ?? undefined,
    ensureAgentTokenFresh: (...args) => ensureAgentTokenFresh(...args),
    chatHistoryManager,
    usageManager,
    ...(credentialsDir ? { credentialsDir } : {}),
    sessionManager,
    fallback: (prompt, cwd, opts) => generateText(prompt, cwd, opts),
  });

  // Internal and host paths refer to the same secrets directory in different mount namespaces.
  const dockerSecretsConfig = process.env.SHIPIT_SECRETS_INTERNAL_DIR
    ? {
      internalDir: process.env.SHIPIT_SECRETS_INTERNAL_DIR,
      ...(process.env.SHIPIT_SECRETS_HOST_DIR ? { hostDir: process.env.SHIPIT_SECRETS_HOST_DIR } : {}),
      entrypointSourcePath: process.env.SHIPIT_SECRETS_ENTRYPOINT
        ?? "/usr/local/share/shipit/secrets-entrypoint.sh",
    }
    : undefined;

  // Keep service secrets outside the agent's workspace mount.
  const serviceEnvDir = process.env.SHIPIT_SERVICE_ENV_DIR
    ?? path.join(stateDir, "service-env");

  const prStatusPollerRef: { ref: PrStatusPoller | null } = { ref: null };

  // Pushes must survive runner disposal, so the scheduler belongs to the process.
  const autoPushScheduler = createAutoPushScheduler({
    debounceMs: autoPushDebounceMs,
    githubAuthManager,
    getRunner: (sessionId) => registryHolder.ref?.get(sessionId) ?? null,
    broadcastLog,
    chatHistory: chatHistoryManager,
    notifyAutoPush: (sessionId) => prStatusPollerRef.ref?.notifyAutoPush(sessionId),
    destructiveGitGuarded: (sessionId) => Boolean(sessionManager.get(sessionId)?.mergedHeadSha),
  });

  const mergeWatchManagerRef: { ref: MergeWatchManager | null } = { ref: null };

  const claudeOAuthRefresherRef: { ref: ClaudeOAuthRefresher | null } = { ref: null };
  const codexOAuthRefresherRef: { ref: CodexOAuthRefresher | null } = { ref: null };
  const nudgeClaudeOAuthRefresh = (): void => {
    const r = claudeOAuthRefresherRef.ref;
    if (!r) return;
    r.refreshNow().catch((err: unknown) => {
      console.error("[claude-oauth-refresh] nudge failed:", err);
    });
  };
  const nudgeCodexOAuthRefresh = (): void => {
    const r = codexOAuthRefresherRef.ref;
    if (!r) return;
    r.refreshNow().catch((err: unknown) => {
      console.error("[codex-oauth-refresh] nudge failed:", err);
    });
  };
  const agentAuthRequiredHooks = new Map<AgentId, () => void>();
  agentAuthRequiredHooks.set("claude", nudgeClaudeOAuthRefresh);
  agentAuthRequiredHooks.set("codex", nudgeCodexOAuthRefresh);
  const onAgentAuthRequired = (agentId: AgentId): void => {
    agentAuthRequiredHooks.get(accountOwnerHarness(agentId))?.();
  };
  const ensureTokenFreshHooks = new Map<
    AgentId,
    (accountId?: string, opts?: { force?: boolean }) => Promise<boolean>
  >();
  ensureTokenFreshHooks.set("claude", async (accountId?: string, opts?: { force?: boolean }): Promise<boolean> => {
    const r = claudeOAuthRefresherRef.ref;
    if (!r) return false;
    try {
      return await r.ensureFresh(accountId, opts);
    } catch (err) {
      console.error("[claude-oauth-refresh] ensureFresh failed:", err);
      return false;
    }
  });
  ensureTokenFreshHooks.set("codex", async (accountId, opts) => {
    if (!accountId) return false;
    return codexOAuthRefresherRef.ref?.ensureFresh(accountId, opts) ?? false;
  });
  const ensureAgentTokenFresh = async (
    agentId: AgentId,
    accountId?: string,
    opts?: { force?: boolean },
  ): Promise<boolean> => {
    const hook = ensureTokenFreshHooks.get(accountOwnerHarness(agentId));
    return hook ? hook(accountId, opts) : true;
  };
  const readSystemPromptApp = (): Promise<string | undefined> =>
    readGlobalSystemPrompt(workspaceDir);

  const agentRuntime = buildAgentRuntime({
    authManager,
    codexAuthManager,
    xaiAuthManager,
    ...(providerAccountManager ? { providerAccountManager } : {}),
  });
  const { authManagers, limitsProviders, runParamsPreps } = agentRuntime;

  providerAccountManager.attachAuthManagers(authManagers);

  // Serialize shared-cache fetches: recovery can delete and clone the cache again.
  const cacheOps = new Map<string, Promise<void>>();
  const fetchPluginRepo = createPluginRepoFetcher({ authority: githubAuthManager, createRepoGit });
  const pluginInstallHook = (sessionId: string, workspaceDir: string): PluginInstallHook | undefined => {
    if (!containerManager) return undefined;
    let sessionStateDir: string;
    try {
      sessionStateDir = sessionStateDirForWorkspace(workspaceDir);
    } catch {
      return undefined;
    }
    return createPluginInstallRunner({
      docker: containerManager.dockerClient,
      image: containerManager.workerImageName,
      sessionId,
      stateDir: sessionStateDir,
      depStoreDir: stateDir,
      egress: () => containerManager.pluginEgressPolicy(sessionId),
      ...(containerManager.workspaceVolumeName
        ? { workspaceVolume: containerManager.workspaceVolumeName, stateRoot: stateDir }
        : {}),
    });
  };
  const pluginActivationDeps = (
    sessionId: string,
    workspaceDir: string,
    onSettled?: (id: string) => void,
  ) => {
    const runInstall = pluginInstallHook(sessionId, workspaceDir);
    const beginGenerationDeletion = containerManager
      ? createGenerationDeletionLease({ docker: containerManager.dockerClient, sessionId })
      : undefined;
    const remoteUrl = sessionManager.get(sessionId)?.remoteUrl;
    return {
      getBareCacheDir,
      pinStorePath: pinStorePath(stateDir),
      ...(onSettled ? { onSettled } : {}),
      ...(runInstall ? { runInstall } : {}),
      ...(beginGenerationDeletion ? { beginGenerationDeletion } : {}),
      validateStaged: createStagedGenerationGate({
        workspaceDir,
        containEgress: () => containerManager?.isEgressContained(sessionId) ?? false,
      }),
      ...(remoteUrl ? { consumerKey: remoteUrl } : {}),
      ensureCache: (cacheDir: string, repoUrl: string) => {
        const previous = cacheOps.get(cacheDir) ?? Promise.resolve();
        // eslint-disable-next-line no-restricted-syntax -- chaining a serial queue in a sync factory
        const next = previous
          .catch(() => undefined)
          .then(() => fetchPluginRepo(cacheDir, repoUrl));
        cacheOps.set(cacheDir, next.catch(() => undefined));
        return next;
      },
    };
  };

  const activatePluginRepos = (
    sessionId: string,
    workspaceDir: string,
    onSettled?: (id: string) => void,
  ): void => {
    const deps = pluginActivationDeps(sessionId, workspaceDir, onSettled);
    void activateDeclaredPlugins(sessionId, workspaceDir, deps, deps.consumerKey)
      .catch((err: unknown) => {
        console.warn(`[plugins:${sessionId}] activation failed:`, err);
      });
  };

  const resolvePluginServices = (
    sessionId: string,
    workspaceDir: string,
  ): Promise<PluginComposeService[]> =>
    resolveSessionPluginServices(sessionId, workspaceDir, {
      ...(containerManager ? { docker: containerManager.dockerClient } : {}),
      depStoreDir: stateDir,
      ...(containerManager?.workspaceVolumeName
        ? { workspaceVolume: containerManager.workspaceVolumeName, stateRoot: stateDir }
        : {}),
      containEgress: containerManager?.isEgressContained(sessionId) ?? false,
    });

  const refreshPluginReposForSession = async (
    sessionId: string,
    workspaceDir: string,
    repoName?: string,
    force?: boolean,
  ): Promise<PluginRefreshResult> => {
    const remoteUrl = sessionManager.get(sessionId)?.remoteUrl;
    if (remoteUrl && !repoStore.isTrusted(remoteUrl)) {
      return {
        rows: [],
        error: "This repository is not trusted yet, so ShipIt will not fetch or run "
          + "anything a plugin repository declares. Trust it in the UI first.",
      };
    }
    const runner = registryHolder.ref?.get(sessionId);
    // Also re-link the worker's plugin generation and skills after refresh.
    const onSettled = runner
      ? emitPluginReposUpdated(runner, { sessionManager, serviceManagers, resolvePluginServices })
      : undefined;
    return await refreshPluginRepos(
      sessionId,
      workspaceDir,
      pluginActivationDeps(sessionId, workspaceDir, onSettled),
      repoName,
      force,
    );
  };

  const runPluginCommandForSession = !containerManager
    ? undefined
    : async (
      sessionId: string,
      workspaceDir: string,
      request: PluginCliRequest,
    ): Promise<PluginCliResult> => {
      const remoteUrl = sessionManager.get(sessionId)?.remoteUrl ?? null;
      if (remoteUrl && !repoStore.isTrusted(remoteUrl)) {
        return {
          error: "This repository is not trusted yet, so ShipIt will not run anything a plugin "
            + "repository declares. Trust it in the UI first.",
          exitCode: 126,
          stdout: "",
          stderr: "",
        };
      }
      return await runPluginCommand(
        {
          docker: containerManager.dockerClient,
          image: containerManager.workerImageName,
          sessionId,
          workspaceDir,
          consumerRepoUrl: remoteUrl,
          secretStore,
          // Archived rows still exist, but their mounts can be removed.
          isCancelled: () => {
            const live = sessionManager.get(sessionId);
            return !live || live.userArchived === true;
          },
          depStoreDir: stateDir,
          egress: () => containerManager.pluginEgressPolicy(sessionId),
          overlayDepDirs: async () => {
            const live = sessionManager.get(sessionId);
            if (!live || !isOverlayEligible(live)) return [];
            return containerManager.resolveSiblingOverlayDepDirs({
              sessionId,
              workspaceDir,
              session: live,
            });
          },
          ...(containerManager.workspaceVolumeName
            ? { workspaceVolume: containerManager.workspaceVolumeName, stateRoot: stateDir }
            : {}),
        },
        request,
      );
    };

  const publishOverlayBases = async ({ runner, session, installOk, installCommands }: {
    runner: ContainerSessionRunner;
    session: SessionInfo;
    installOk: boolean;
    installCommands?: string[];
  }): Promise<DepDirPublishOutcome[]> => {
    if (!isOverlayEnabled() || !session.remoteUrl) return [];
    await runner.whenWorkerReady();
    // Disposal also resolves whenWorkerReady.
    if (runner.disposed) return [];

    const controller = new AbortController();
    const onDisposed = (): void => controller.abort(new Error("session runner disposed"));
    runner.on("disposed", onDisposed);
    try {
      return await publishDepDirOverlayBases(
        { session, workerUrl: runner.getWorkerUrl(), installOk, installCommands, signal: controller.signal },
        { stateDir, createRepoGit, getBareCacheDir },
      );
    } finally {
      runner.off("disposed", onDisposed);
    }
  };

  const markSessionAccountExhausted = (sessionId: string, until: number, capturedRouteId?: string): void => {
    // Attribute exhaustion only to the turn's captured route.
    const routeId = capturedRouteId;
    if (!routeId) return;
    const account = providerAccountManager?.getByRouteId(routeId);
    if (account) {
      const marked = providerAccountManager?.markAccountExhausted(account.serviceId, routeId, until);
      if (marked) {
        console.log(
          `[quota] account ${routeId} reported exhausted by session `
          + `${sessionId}; benched until ${new Date(until).toISOString()}`,
        );
      }
      return;
    }
    const benched = credentialStore.markCredentialRouteExhausted(routeId, until);
    if (benched) {
      console.log(
        `[quota] ${benched.serviceId}:${benched.billingMode} credential ${benched.id} reported exhausted `
        + `by session ${sessionId}; benched until ${new Date(until).toISOString()}`,
      );
    }
  };

  const markCredentialRouteAuthFailed = (routeId: string): void => {
    if (!credentialStore.markCredentialRouteAuthFailed(routeId)) return;
    console.log(`[auth] credential ${routeId} refused a turn; marked auth_failed`);
    sseBroadcast("credential_routes", { routes: listCredentialRoutesForWire(credentialStore) });
  };

  const clearCredentialRouteAuthFailed = (routeId: string): void => {
    if (!credentialStore.clearCredentialRouteAuthFailed(routeId)) return;
    console.log(`[auth] credential ${routeId} authenticated a turn; cleared auth_failed`);
    sseBroadcast("credential_routes", { routes: listCredentialRoutesForWire(credentialStore) });
  };

  const agentMergeClaims = new AgentMergeClaimStore(databaseManager);

  const runnerRegistry = createRunnerRegistry({
    effectiveRunnerFactory, sessionManager, repoStore, createGitManager,
    githubAuthManager, agentFactory, chatHistoryManager,
    autoPushScheduler, sseBroadcast, enforceIdleContainerLimit,
    getDepCacheDir, serviceManagers, composeStopPromises, composeWarnings, composeNotConfigured, containerManager,
    credentialStore, secretStore, runtimeMode, broadcastLog,
    usageManager, runParamsPreps,
    markSessionAccountExhausted,
    markCredentialRouteAuthFailed,
    clearCredentialRouteAuthFailed,
    nudgeClaudeOAuthRefresh,
    onAgentAuthRequired,
    ensureAgentTokenFresh,
    publishOverlayBases,
    activatePluginRepos,
    resolvePluginServices,
    logStore,
    ...(dockerSecretsConfig ? { dockerSecretsConfig } : {}),
    serviceEnvDir,
    ...(credentialsDir ? { credentialsDir } : {}),
    ...(providerAccountManager ? { providerAccountManager } : {}),
    readSystemPrompt: readSystemPromptApp,
    generateText: effectiveGenerateText,
    getPrStatusPoller: () => prStatusPollerRef.ref ?? undefined,
    rebindDelivery: (deliveryId: string) => mergeWatchManagerRef.ref?.rebindDelivery(deliveryId),
    getAutoConflictResolveManager: () => prStatusPollerRef.ref?.autoConflictResolveManager,
    isAgentMergeInFlight: (sessionId: string) => agentMergeClaims.isMergeInFlight(sessionId),
    reconcileAgentMergeClaimsFor: (sessionId: string) => {
      void reconcileAgentMergeClaims({
        claims: agentMergeClaims,
        sessionManager,
        chatHistoryManager,
        ...(prStatusPollerRef.ref ? { prStatusPoller: prStatusPollerRef.ref } : {}),
        ...(registryHolder.ref ? { runnerRegistry: registryHolder.ref } : {}),
      }, { sessionId }).catch((err: unknown) => {
        console.error(`[agent-merge] end-of-turn reconciliation for ${sessionId} failed:`, err);
      });
    },
  });
  registryHolder.ref = runnerRegistry;

  const repoPrefetcher: RepoPrefetcher | null = isTestMode ? null : createRepoPrefetcher({
    repoStore, getBareCacheDir, createRepoGit, githubAuthManager,
  });
  repoPrefetcher?.start();

  const drainQueueForSession = (sessionId: string): void => {
    const runner = runnerRegistry.get(sessionId);
    if (!runner) return;
    releaseQueuedTurn(runner);
  };

  const mergeWatchManager = new MergeWatchManager({
    sessionManager,
    runnerRegistry,
    chatHistoryManager,
    defaultAgentId,
    credentialsDir,
    credentialStore,
    providerAccountManager,
    containerManager,
    restoreWorkspace: (sessionId: string) =>
      restoreSessionWorkspace(
        sessionManager, createRepoGit, getBareCacheDir, githubAuthManager, repoStore, sessionId,
      ),
  });
  mergeWatchManagerRef.ref = mergeWatchManager;

  const prStatusPoller = createPrStatusPoller({
    deps, githubAuthManager, sessionManager, sseBroadcast,
    runnerRegistry, defaultAgentId, createRepoGit, createGitManager, getBareCacheDir,
    mergeWatchManager,
    pruneSessionVolumes: isTestMode ? undefined : pruneSessionVolumes,
    containerManager,
    ...(repoPrefetcher ? { onRepoMainAdvanced: (url: string) => repoPrefetcher.prefetchRepo(url) } : {}),
    chatHistoryManager,
    usageManager,
    credentialStore,
    drainQueueForSession,
    ...(agentFactory ? { agentFactory } : {}),
  });
  prStatusPollerRef.ref = prStatusPoller;

  mergeWatchManager.setPrStatusLookup((id) => prStatusPoller.getStatus(id));
  const releaseStatusPoller = new ReleaseStatusPoller({
    githubAuth: githubAuthManager,
    onCard: (card) => {
      chatHistoryManager.upsertReleaseCard(card.sessionId, card);
      runnerRegistry
        .get(card.sessionId)
        ?.emitMessage({ type: "release_card", sessionId: card.sessionId, card });
    },
    runnerRegistry,
  });

  let limitsRegistry: LimitsRegistry | null = null;

  wireEventHandlers({
    authManagers,
    githubAuthManager, agentRegistry,
    providerAccountManager,
    sseBroadcast, credentialsDir, sessionManager,
    credentialStore,
    onCredentialReplaced: (agentId, accountId) => {
      const provider = limitsProviders.get(agentId);
      if (!provider) return;
      limitsRegistry?.markSignedOut(limitsModeKey(provider), accountId);
    },
    hasLiveAgent: (sessionId) => sessionHasLiveAgent(runnerRegistry, sessionId),
  });

  if (!isTestMode) {
    const repushOAuthAccountToken = (logPrefix: string) => (agentId: AgentId, accountId: string): void => {
      let healed = 0;
      for (const session of sessionManager.list()) {
        if (!session.agentPinned || session.agentId !== agentId) continue;
        // Use the credential subtree's account marker; routing may have changed.
        const marked = readSessionAccountMarker(credentialsDir, session.id)[agentId];
        if (marked !== undefined && marked !== accountId) continue;
        try {
          // Credential repair unlinks files and would interrupt a live CLI.
          const opts = { repairLeakedSubtrees: !sessionHasLiveAgent(runnerRegistry, session.id) };
          const wrote =
            marked !== undefined
              ? repushProviderAccountToken(credentialsDir, session.id, agentId, accountId, undefined, undefined, opts)
              : repushAgentToken(credentialsDir, session.id, agentId, undefined, undefined, opts);
          if (wrote) healed++;
        } catch (err) {
          console.error(`[${logPrefix}] repush failed for session ${session.id}:`, err);
        }
      }
      if (healed > 0) {
        console.log(`[${logPrefix}] propagated refreshed ${agentId}/${accountId} token to ${healed} pinned session(s)`);
      }
    };
    const refresher = new ClaudeOAuthRefresher({
      credentialsDir,
      providerAccountManager,
      repushAccountToken: repushOAuthAccountToken("claude-oauth-refresh"),
      sseBroadcast,
      runtimeMode,
    });
    claudeOAuthRefresherRef.ref = refresher;
    refresher.start();
    refresher.on("account_unauthenticated", (accountId: string) => {
      markProviderAccountUnauthenticated({
        agentId: "claude",
        accountId,
        providerAccountManager,
        agentRegistry,
        sseBroadcast,
        credentialStore,
      });
    });
    refresher.on("account_reauthenticated", (accountId: string) => {
      markProviderAccountReauthenticated({
        agentId: "claude",
        accountId,
        providerAccountManager,
        agentRegistry,
        sseBroadcast,
        credentialStore,
      });
    });
    authManager.on("auth_complete", () => {
      refresher.refreshNow().catch((err: unknown) => {
        console.error("[claude-oauth-refresh] post-auth refresh failed:", err);
      });
    });

    const codexRefresher = new CodexOAuthRefresher({
      credentialsDir,
      providerAccountManager,
      repushAccountToken: repushOAuthAccountToken("codex-oauth-refresh"),
      sseBroadcast,
      runtimeMode,
    });
    // Reattach durable consumers before the owner can publish a new token.
    for (const session of sessionManager.listAll()) {
      const home = perSessionCredentialsDir(credentialsDir, session.id);
      const sourceForAccount = (id: string) => providerAccountManager.resolveCredentialRoot("codex", id);
      restoreOpenCodeAccount(home, sourceForAccount);
      const spawns = path.join(home, "sub-agent-homes");
      if (fs.existsSync(spawns)) {
        for (const entry of fs.readdirSync(spawns, { withFileTypes: true })) {
          if (entry.isDirectory()) restoreOpenCodeAccount(path.join(spawns, entry.name), sourceForAccount);
        }
      }
    }
    codexOAuthRefresherRef.ref = codexRefresher;
    codexRefresher.start();
    codexRefresher.on("account_unauthenticated", (accountId: string) => {
      markProviderAccountUnauthenticated({
        agentId: "codex",
        accountId,
        providerAccountManager,
        agentRegistry,
        sseBroadcast,
        credentialStore,
      });
    });
    codexRefresher.on("account_reauthenticated", (accountId: string) => {
      markProviderAccountReauthenticated({
        agentId: "codex",
        accountId,
        providerAccountManager,
        agentRegistry,
        sseBroadcast,
        credentialStore,
      });
    });
    authManagers.get("openai-chatgpt")?.on("complete", () => {
      codexRefresher.refreshNow().catch((err: unknown) => {
        console.error("[codex-oauth-refresh] post-auth refresh failed:", err);
      });
    });
  }

  const zaiLimitsProvider = new ZaiLimitsProvider({
    listRouteIds: () =>
      credentialStore
        .listCredentialRoutes(ZAI_SERVICE_ID, "sub")
        .filter((route) => route.via === "string" && credentialStore.getCredentialSecret(route.id) !== undefined)
        .map((route) => route.id),
    secretForRoute: (routeId) => credentialStore.getCredentialSecret(routeId),
  });

  const xaiLimitsProvider = new XaiLimitsProvider({
    listRouteIds: () =>
      providerAccountManager
        ?.list(XAI_SERVICE_ID)
        .filter((account) => account.status === "ready" || account.status === "authenticating")
        .map((account) => account.id) ?? [],
    credentialDirForRoute: (routeId) =>
      providerAccountManager?.get(XAI_SERVICE_ID, routeId)
        ? providerAccountManager.resolveCredentialRoot("grok", routeId)
        : undefined,
  });

  const pulledLimitsProviders = [zaiLimitsProvider, xaiLimitsProvider];

  const limitsProvidersByMode = new Map(
    [...limitsProviders.values(), ...pulledLimitsProviders].map((p) => [limitsModeKey(p), p]),
  );
  limitsRegistry = !isTestMode
    ? new LimitsRegistry({ providers: limitsProvidersByMode, sseBroadcast })
    : null;
  if (limitsRegistry) {
    providerAccountManager?.attachSubscriptionLimits(() => limitsRegistry.getSnapshot());
    for (const [loginId, mgr] of authManagers) {
      const loginServiceId = serviceForLoginIntegration(loginId);
      const provider = [...limitsProvidersByMode.values()].find(
        (candidate) => candidate.serviceId === loginServiceId && candidate.billingMode === "sub",
      );
      if (!provider) continue;
      const modeKey = limitsModeKey(provider);
      mgr.on("complete", () => {
        const accountId = mgr.getActiveAccountId() ?? undefined;
        if (!accountId) return;
        limitsRegistry.markAuthRefreshed(modeKey);
        void limitsRegistry.refreshNow(modeKey, "seed", accountId);
      });
    }

    for (const provider of pulledLimitsProviders) {
      const modeKey = limitsModeKey(provider);
      for (const routeId of provider.routeIds()) {
        void limitsRegistry.refreshNow(modeKey, "seed", routeId);
      }
    }
  }

  const recordAgentRateLimits: AppCtx["recordAgentRateLimits"] = (agentId, session, weekly, sessionId, explicitRouteId) => {
    const routeId = explicitRouteId
      ?? providerAccountManager?.selectRouteForTurn(accountServiceForHarness(agentId))?.id;
    if (!routeId) return;
    const owner = credentialOwnerForRouteId(routeId, credentialStore);
    if (owner?.billingMode !== "sub") return;
    const modeKey = limitsModeKey(owner);
    limitsProvidersByMode.get(modeKey)?.setRateLimits(session, weekly, routeId);
    limitsRegistry?.markAuthRefreshed(modeKey);
    const reading = { session, weekly, fetchedAt: Date.now() };
    providerAccountManager?.clearRefusalOnHealthyReading(owner.serviceId, routeId, reading);
    credentialStore.clearCredentialRefusalOnHealthyReading(routeId, reading);
  };

  const createSessionDir = createSessionDirFactory({
    sessionsRoot, sessionManager,
  });

  const preStartWarmPreview = containerManager
    ? createWarmPreviewStarter({
        repoStore, sessionManager, serviceManagers, composeStopPromises,
        containerManager, secretStore, credentialStore, serviceEnvDir, logStore,
        ...(dockerSecretsConfig ? { dockerSecretsConfig } : {}),
        isSessionActive: (sessionId: string) => !!registryHolder.ref?.get(sessionId),
      })
    : undefined;

  const { warmSessionForRepo, waitForWarmSession, ensureStandbyForWarmSession } = createWarmPool({
    repoStore, sessionManager, createRepoGit,
    githubAuthManager, containerManager,
    credentialsDir, getBareCacheDir, getDepCacheDir, createSessionDir, sseBroadcast,
    oomBreaker,
    getMemoryStats: () => latestMemoryStats.value,
    ...(preStartWarmPreview ? { preStartPreview: preStartWarmPreview } : {}),
  });

  // Scrub before migration creates repo rows; move directories keyed by the old URL hash too.
  await runRemoteCredentialScrub({
    repoStore, sessionManager, secretStore,
    repoKeyedDirs: [
      (hash: string): string => path.join(bareCacheRoot(stateDir), hash),
      (hash: string): string => path.join(depCacheRoot(stateDir), hash),
      ...(credentialsDir ? [(hash: string): string => repoMemoryDir(credentialsDir, hash)] : []),
    ],
  });

  const migratedRepoUrls = await runRepoMigration({
    repoStore, sessionManager, getSharedRepoDir: getBareCacheDir,
  });

  const startupTimer = scheduleStartupTasks({
    repoStore, sessionManager, chatHistoryManager, usageManager,
    containerManager, getBareCacheDir, warmSessionForRepo, credentialStore,
  }, migratedRepoUrls);

  // Finish consult cards before adopted turns replace their in-progress history rows.
  reconcileOrphanedConsultCards(chatHistoryManager);

  // Adopt surviving turns before merge automation can mistake the empty registry for idle sessions.
  try {
    await reattachInFlightTurns({
      containerManager, runnerRegistry, sessionManager, defaultAgentId,
      orchestratorBuildId: process.env.SHIPIT_BUILD_ID,
    });
  } catch (err: unknown) {
    console.error("[turn-reattach] startup sweep failed:", err);
  }
  void reconcileAgentMergeClaims({
    claims: agentMergeClaims,
    sessionManager,
    chatHistoryManager,
    prStatusPoller,
    runnerRegistry,
  }).catch((err: unknown) => {
    console.error("[agent-merge] startup reconciliation failed:", err);
  });

  const agentMergeExecutor = new AgentMergeExecutor({
    claims: agentMergeClaims,
    sessionManager,
    chatHistoryManager,
    repoStore,
    githubAuthManager,
    prStatusPoller,
    runnerRegistry,
  });
  agentMergeExecutor.start();

  void (async () => {
    try {
      await mergeWatchManager.reconcilePending();
    } catch (err: unknown) {
      console.error("[merge-watch] startup reconcile failed:", err);
    }
  })();

  void refreshAllRepoDefaultBranches({
    repoStore, createRepoGit, getBareCacheDir, sseBroadcast,
  }).catch((err: unknown) => {
    console.error("[repo-default-branch] startup sweep failed:", err);
  });

  return {
    ...meta,
    deps,
    defaultAgentId, workspaceDir, stateDir, credentialsDir, shouldServeStatic,
    autoPushDebounceMs, sessionsRoot, agentFactory, localAgentFactory,
    createGitManager, createRepoGit, databaseManager, sessionManager,
    repoStore, chatHistoryManager, usageManager, authManager, codexAuthManager,
    xaiAuthManager,
    credentialStore, providerAccountManager, agentRegistry, githubAuthManager,
    secretStore, reviewStore, egressAllowlistStore, presentStore,
    generateText: effectiveGenerateText,
    isTestMode, runtimeMode,
    containerManager, dockerProxyServer, dockerForStats,
    getBareCacheDir, getDepCacheDir,
    marketplaceStore,
    sseClients, sseBroadcast,
    logStore, getLogBuffer, clearLogBuffer, removeLogBuffer, broadcastLog, removeSessionLogs,
    oomBreaker, loopDetector,
    effectiveRunnerFactory,
    serviceManagers, composeStopPromises, composeWarnings, composeNotConfigured,
    latestMemoryStats,
    registryHolder, enforceIdleContainerLimit,
    autoPushScheduler,
    dockerSecretsConfig, serviceEnvDir,
    prStatusPollerRef,
    claudeOAuthRefresherRef, codexOAuthRefresherRef,
    nudgeClaudeOAuthRefresh, nudgeCodexOAuthRefresh,
    agentAuthRequiredHooks, onAgentAuthRequired,
    ensureTokenFreshHooks, ensureAgentTokenFresh,
    readSystemPromptApp,
    agentRuntime, authManagers, limitsProviders, runParamsPreps,
    publishOverlayBases,
    activatePluginRepos,
    refreshPluginReposForSession,
    runPluginCommandForSession,
    runnerRegistry,
    repoPrefetcher,
    drainQueueForSession,
    mergeWatchManager,
    prStatusPoller,
    releaseStatusPoller,
    limitsRegistry,
    recordAgentRateLimits,
    markSessionAccountExhausted,
    createSessionDir,
    warmSessionForRepo, waitForWarmSession, ensureStandbyForWarmSession, preStartWarmPreview,
    migratedRepoUrls,
    startupTimer,
    agentMergeClaims,
    agentMergeExecutor,
  };
}

export type OrchestratorRuntime = Awaited<ReturnType<typeof bootstrapManagers>>;
