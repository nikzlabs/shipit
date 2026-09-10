import path from "node:path";
import type { FastifyInstance } from "fastify";
import { composeEgressExtraHosts, composeEgressIdentityRules, sandboxLifelineEgressConfig } from "./egress-allowlist.js";
import type { ResolvedEgressConfig } from "./egress-allowlist.js";
import { setEgressDurableSource } from "./egress-policy.js";
import { assertWorkerUidConsistency } from "./worker-uid-guard.js";
import { assertWorkerUidNotReserved, sealLegacySessionDirs, sessionWorkerGid } from "./session-worker-uid.js";
import { assertSessionUidRange, configureSessionUidLedger } from "./session-uid-allocator.js";
import { configureSessionIdentityRoots } from "../shared/session-identity.js";
import { perSessionCredentialsRoot } from "./session-credentials-scaffold.js";
import { resolveBuildId, resolveVersion } from "./build-id.js";
import { getUpdateMode } from "./services/updates.js";
import { readChannel } from "./release-channel.js";

import type { PrStatusPoller } from "./pr-status-poller.js";
import type { ReleaseStatusPoller } from "./release-status-poller.js";
import type { MergeWatchManager } from "./merge-watch.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { SessionManager } from "./sessions.js";
import type { ChatHistoryManager } from "./chat-history.js";
import type { UsageManager } from "./usage.js";

import type { AppDeps } from "./app-di.js";
import { initializeManagers } from "./app-di.js";
import { createOrchestratorApp } from "./app-assembly.js";
import { bootstrapManagers } from "./bootstrap-managers.js";
import { startStartupMonitors } from "./startup-monitors.js";
import { registerSseEndpoint, registerRoutes } from "./route-registry.js";
import { autoStart } from "./app-lifecycle.js";

export { CONTEXT_WINDOW_TOKENS } from "./ws-handlers/send-message.js";
export type { AppDeps } from "./app-di.js";
export { initializeManagers } from "./app-di.js";
export type { ManagerSet } from "./app-di.js";
export {
  setupContainerManager,
  buildRunnerFactory,
  createIdleEnforcer,
  createMissingContainerReconciler,
  createRunnerRegistry,
  createSSE,
  createPrStatusPoller,
  createLogBuffer,
  wireEventHandlers,
  markProviderAccountUnauthenticated,
  markProviderAccountReauthenticated,
  createSessionDirFactory,
  createBareCacheDirHelper,
  createDepCacheDirHelper,
  createWarmPool,
  runRepoMigration,
  scheduleStartupTasks,
  setupContainerHealthMonitoring,
  registerShutdownHook,
  autoStart,
} from "./app-lifecycle.js";
export type {
  ContainerSetupDeps,
  ContainerSetupResult,
  RunnerFactoryDeps,
  IdleEnforcementDeps,
  RunnerRegistryDeps,
  SSEClient,
  PrPollerDeps,
  EventWiringDeps,
  SessionDirDeps,
  WarmPoolDeps,
  StartupDeps,
  ShutdownDeps,
} from "./app-lifecycle.js";

export async function buildApp(deps: AppDeps = {}): Promise<FastifyInstance> {
  // Reject identities exempt from egress rules before any durable state changes.
  assertWorkerUidNotReserved();

  assertSessionUidRange();

  const processStartedAt = Date.now();
  const buildId = resolveBuildId();
  const version = resolveVersion(await readChannel());
  const updateMode = getUpdateMode();
  const clientDir = path.resolve(process.cwd(), "dist/client");

  const mgrs = await initializeManagers(deps);
  const {
    egressAllowlistStore, credentialStore, runtimeMode, isTestMode, stateDir, sessionManager,
    sessionsRoot, credentialsDir,
  } = mgrs;

  // Configure identity roots before any ownership changes inside a session.
  configureSessionUidLedger(mgrs.databaseManager.db);
  const sharedWorkerGid = sessionWorkerGid();
  configureSessionIdentityRoots({
    sessionsRoot,
    credentialsSessionsRoot: perSessionCredentialsRoot(credentialsDir),
    ...(sharedWorkerGid === null
      ? {}
      : { fallbackIdentity: { uid: sharedWorkerGid, gid: sharedWorkerGid } }),
  });
  if (!isTestMode) sealLegacySessionDirs(sessionsRoot);

  const resolveEgressConfig = (sessionId: string): ResolvedEgressConfig => {
    const lifeline = sandboxLifelineEgressConfig(
      sessionManager.get(sessionId),
      composeEgressIdentityRules(),
    );
    if (lifeline) return lifeline;
    return {
      contained: egressAllowlistStore.resolveContained(sessionId),
      extraHosts: composeEgressExtraHosts({
        credentialStore,
        durableHosts: egressAllowlistStore.effectiveHosts(sessionId),
      }),
      base: egressAllowlistStore.effectiveBase(),
      identityRules: composeEgressIdentityRules(),
    };
  };
  setEgressDurableSource((sessionId) => egressAllowlistStore.effectiveHosts(sessionId));

  if (runtimeMode === "containerized" && !isTestMode) {
    assertWorkerUidConsistency({
      stateDir,
      hasPersistedSessions: sessionManager.listAll().length > 0,
    });
  }

  const app = await createOrchestratorApp(undefined, runtimeMode);

  const rt = await bootstrapManagers({
    deps,
    mgrs,
    resolveEgressConfig,
    meta: { processStartedAt, buildId, version, updateMode, clientDir },
  });

  registerSseEndpoint(app, rt);

  const monitors = await startStartupMonitors(app, rt);

  await registerRoutes(app, rt, monitors);

  app.decorate("prStatusPoller", rt.prStatusPoller);
  app.decorate("mergeWatchManager", rt.mergeWatchManager);
  app.decorate("releaseStatusPoller", rt.releaseStatusPoller);
  app.decorate("runnerRegistry", rt.runnerRegistry);
  app.decorate("sessionManager", rt.sessionManager);
  app.decorate("chatHistoryManager", rt.chatHistoryManager);
  app.decorate("usageManager", rt.usageManager);
  app.decorate("agentMergeClaims", rt.agentMergeClaims);

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    prStatusPoller?: PrStatusPoller;
    mergeWatchManager?: MergeWatchManager;
    releaseStatusPoller?: ReleaseStatusPoller;
    runnerRegistry: SessionRunnerRegistry;
    sessionManager: SessionManager;
    chatHistoryManager: ChatHistoryManager;
    usageManager: UsageManager;
  }
}

if (!process.env.VITEST) {
  void autoStart(buildApp);
}
