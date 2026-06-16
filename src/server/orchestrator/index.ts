import path from "node:path";
import type { FastifyInstance } from "fastify";
import { composeEgressExtraHosts, composeEgressIdentityRules } from "./egress-allowlist.js";
import type { ResolvedEgressConfig } from "./egress-allowlist.js";
import { setEgressDurableSource } from "./egress-policy.js";
import { assertWorkerUidConsistency } from "./worker-uid-guard.js";
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

// ---- Sub-module imports (P4 split — docs/201) ----
import type { AppDeps } from "./app-di.js";
import { initializeManagers } from "./app-di.js";
import { createOrchestratorApp } from "./app-assembly.js";
import { bootstrapManagers } from "./bootstrap-managers.js";
import { startStartupMonitors } from "./startup-monitors.js";
import { registerSseEndpoint, registerRoutes } from "./route-registry.js";
import { autoStart } from "./app-lifecycle.js";

// ---- Re-exports for backwards compatibility ----
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

/**
 * Build and configure the Fastify app with all routes and WebSocket handlers.
 * Returns the app instance without starting it — call `app.listen()` separately.
 *
 * This separation enables integration testing: tests can call `buildApp({ ... })`
 * with mock dependencies, then use `app.inject()` or connect WebSocket clients
 * to the app without spawning real child processes.
 *
 * `buildApp()` is the ordered entry point of the orchestrator composition root.
 * The heavy lifting is split (docs/201 — P4) across cohesive siblings called in
 * sequence, with the wiring order preserved exactly:
 *   1. `app-di.ts` — instantiate managers
 *   2. `app-assembly.ts` — create the Fastify instance + transport middleware
 *   3. `bootstrap-managers.ts` — instantiate + wire collaborators (DI block)
 *   4. `route-registry.ts` — register the SSE endpoint
 *   5. `startup-monitors.ts` — start monitors + register lifecycle hooks
 *   6. `route-registry.ts` — register HTTP routes + the WebSocket route
 */
export async function buildApp(deps: AppDeps = {}): Promise<FastifyInstance> {
  // Captured once at process startup so the client can render a live
  // uptime badge. This is the user's only signal that "Just Restart"
  // actually bounced the orchestrator — without it, a restart that
  // takes < 5s is invisible.
  const processStartedAt = Date.now();
  const buildId = resolveBuildId();
  // Channel-aware human-facing version of the running instance (feature 162).
  // Computed once at startup: it describes what is actually running, not what
  // channel is selected for the *next* update. A channel switch + Update Now
  // restarts the orchestrator, which recomputes this.
  const version = resolveVersion(await readChannel());
  const updateMode = getUpdateMode();
  const clientDir = path.resolve(process.cwd(), "dist/client");

  // ---- DI: instantiate all managers ----
  const mgrs = await initializeManagers(deps);
  const {
    egressAllowlistStore, credentialStore, runtimeMode, isTestMode, stateDir, sessionManager,
  } = mgrs;

  // ---- Egress containment config resolver (docs/172, SHI-90) ----
  // The single seam that turns the durable allowlist store + the live MCP
  // credential store + operator env extras into a per-session egress decision at
  // container start: whether to contain the session (global toggle / per-session
  // override) and the composed extra-host allowlist fed into BOTH the Tier B
  // resolver config and the Tier C SNI proxy. Also injected into `egress-policy`
  // so the Tier C decision endpoint honors durable allows without re-carding.
  const resolveEgressConfig = (sessionId: string): ResolvedEgressConfig => ({
    contained: egressAllowlistStore.resolveContained(sessionId),
    extraHosts: composeEgressExtraHosts({
      credentialStore,
      durableHosts: egressAllowlistStore.effectiveHosts(sessionId),
    }),
    // The built-in base minus any defaults the user removed in Settings — so a
    // removed default is actually closed at the resolver + proxy.
    base: egressAllowlistStore.effectiveBase(),
    // docs/172 Phase 2 — SNI-scoped tenant identity rules for multi-tenant hosts,
    // from the operator env (SESSION_EGRESS_IDENTITY_RULES). "" when none → the
    // proxy launch omits EGRESS_PROXY_IDENTITY_RULES (no identity scoping).
    identityRules: composeEgressIdentityRules(),
  });
  setEgressDurableSource((sessionId) => egressAllowlistStore.effectiveHosts(sessionId));

  // docs/150 Rollout — fail-fast on SHIPIT_SESSION_WORKER_UID drift before we
  // accept any traffic or restore containers. Containerized prod only: local
  // mode has no `shipit` worker, and tests inject their own state. Throwing here
  // aborts buildApp, which exits the process — the intended fail-fast.
  if (runtimeMode === "containerized" && !isTestMode) {
    assertWorkerUidConsistency({
      stateDir,
      hasPersistedSessions: sessionManager.listAll().length > 0,
    });
  }

  // ---- Fastify instance + transport middleware ----
  const app = await createOrchestratorApp();

  // ---- Managers + collaborator wiring (the DI block) ----
  const rt = await bootstrapManagers({
    deps,
    mgrs,
    resolveEgressConfig,
    meta: { processStartedAt, buildId, version, updateMode, clientDir },
  });

  // ---- SSE endpoint ----
  // Registered in its original position — after manager wiring but before the
  // startup monitors — so the `buildApp()` ordering is preserved.
  registerSseEndpoint(app, rt);

  // ---- Startup monitors + process-lifecycle hooks ----
  // (memory stats, idle enforcement + reconciler, disk janitor + escalation,
  // container health monitoring, interval-cleanup `onClose`, graceful shutdown).
  const monitors = await startStartupMonitors(app, rt);

  // ---- HTTP API routes, preview proxy, test endpoints, static, WebSocket ----
  await registerRoutes(app, rt, monitors);

  // docs/146 — minimal test-surface decorations. Integration tests need
  // direct access to the wired collaborators (poller's auto-resolve
  // manager, runner registry, shared managers) to drive flows that bypass
  // the GraphQL polling layer. Production code does NOT read from these —
  // routes / WS handlers consume the references through their own closures
  // / DI. Adding them here just lets tests stop reaching through
  // module-private state.
  app.decorate("prStatusPoller", rt.prStatusPoller);
  app.decorate("mergeWatchManager", rt.mergeWatchManager);
  app.decorate("releaseStatusPoller", rt.releaseStatusPoller);
  app.decorate("runnerRegistry", rt.runnerRegistry);
  app.decorate("sessionManager", rt.sessionManager);
  app.decorate("chatHistoryManager", rt.chatHistoryManager);
  app.decorate("usageManager", rt.usageManager);

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    /** docs/146 — test-surface decoration. See `index.ts`. */
    prStatusPoller?: PrStatusPoller;
    /** docs/196 — test-surface decoration for the notify-on-merge deliverer. */
    mergeWatchManager?: MergeWatchManager;
    /** docs/171 — test-surface decoration for the release lifecycle poller. */
    releaseStatusPoller?: ReleaseStatusPoller;
    runnerRegistry: SessionRunnerRegistry;
    sessionManager: SessionManager;
    chatHistoryManager: ChatHistoryManager;
    usageManager: UsageManager;
  }
}

// Only start the server when this file is the entry point (not when imported by tests).
// Vitest sets process.env.VITEST; alternatively check import.meta.url vs process.argv[1].
if (!process.env.VITEST) {
  void autoStart(buildApp);
}
