import path from "node:path";
import type { FastifyInstance } from "fastify";
import { composeEgressExtraHosts, composeEgressIdentityRules, sandboxLifelineEgressConfig } from "./egress-allowlist.js";
import type { ResolvedEgressConfig } from "./egress-allowlist.js";
import { setEgressDurableSource } from "./egress-policy.js";
import { firstTurnEgressPin } from "./services/first-turn-admission.js";
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
  // docs/263 — refuse a SHIPIT_SESSION_WORKER_UID that collides with an egress
  // sidecar uid (911/912) BEFORE anything else runs. The netns firewall exempts
  // those uids by owner-match, so a workload holding one runs exempt from the
  // tier that names it — the agent container and the plugin containers share
  // that arrangement, which is why the refusal lives at the shared parse site
  // rather than on either path.
  //
  // First statement in the composition root, ahead of `initializeManagers`,
  // because that step migrates the database, adopts environment credentials and
  // writes the global gitconfig — a boot we are about to refuse must not mutate
  // durable state first. It also pre-empts `initGlobalGitConfig`, which parses
  // the same variable (`git-config.ts:59`) and would otherwise throw the same
  // error from a call that does not explain itself. Unconditional, unlike the
  // drift guard below, which needs the containerized state dir.
  assertWorkerUidNotReserved();

  // docs/270 — the same shape, for the range per-session uids are allocated from.
  // The range cannot contain 911/912 as written, so this refusal only fires if
  // the constants are edited into overlap — which is exactly when a silent
  // failure would matter, since a session allocated one of them would run exempt
  // from egress containment. Unconditional and next to the check above for the
  // same reason: the property is of the constants, not of the deployment.
  assertSessionUidRange();

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
    sessionsRoot, credentialsDir,
  } = mgrs;

  // docs/270 — tell the identity resolver where per-session paths live, then
  // seal the session directories that predate it.
  //
  // Ordering: this must precede anything that chowns inside a session, because
  // every chown helper now asks this resolver whose the path is. It follows
  // `initializeManagers` only because that is where the two roots are computed;
  // nothing in that step writes into a session directory.
  //
  // Gated on the non-root runtime by `sealLegacySessionDirs` itself, and on the
  // roots being configured by the resolver — so local mode, dogfood and every
  // test keep exactly the behaviour they had.
  // docs/270 — the allocation ledger, configured once. See the allocator's own
  // note on why this is configured rather than threaded through the two
  // functions that create a session directory.
  configureSessionUidLedger(mgrs.databaseManager.db);
  const sharedWorkerGid = sessionWorkerGid();
  configureSessionIdentityRoots({
    sessionsRoot,
    credentialsSessionsRoot: perSessionCredentialsRoot(credentialsDir),
    // What a session path resolves to when its directory carries no record —
    // the seal did not run, or could not. Never the tree: that is writable from
    // inside the session, which is the whole reason the record moved off it.
    ...(sharedWorkerGid === null
      ? {}
      : { fallbackIdentity: { uid: sharedWorkerGid, gid: sharedWorkerGid } }),
  });
  if (!isTestMode) sealLegacySessionDirs(sessionsRoot);

  // ---- Egress containment config resolver (docs/172, planning#92) ----
  // The single seam that turns the durable allowlist store + the live MCP
  // credential store + operator env extras into a per-session egress decision at
  // container start: whether to contain the session (global toggle / per-session
  // override) and the composed extra-host allowlist fed into BOTH the Tier B
  // resolver config and the Tier C SNI proxy. Also injected into `egress-policy`
  // so the Tier C decision endpoint honors durable allows without re-carding.
  const resolveEgressConfig = (sessionId: string): ResolvedEgressConfig => {
    // docs/211 — a sandbox session with the `network` capability OFF is dropped
    // to **lifeline-only** egress (LLM API + orchestrator/worker, + github.com
    // when `git` is granted). `sandboxLifelineEgressConfig` returns null for
    // every other session, falling through to the normal store-driven path
    // below (parity with any session — `network` ON is the default). Inert where
    // egress enforcement isn't deployed.
    const lifeline = sandboxLifelineEgressConfig(
      sessionManager.get(sessionId),
      composeEgressIdentityRules(),
    );
    if (lifeline) return lifeline;
    // docs/285 — a session whose FIRST turn has been admitted carries the
    // containment it was admitted under, and creation reads that instead of
    // re-reading the store. Containment is plumbed when the container is
    // created, which happens an unbounded time after the turn was admitted (the
    // readiness wait is bounded at 8s and can return with the replacement still
    // `starting`), so a settings write landing in between used to move the
    // in-flight turn to a policy the user never chose for it. `undefined`
    // whenever no first turn is in flight, which is almost always.
    //
    // BELOW the lifeline check on purpose: a docs/211 sandbox with `network`
    // off is a tightening the user's Contained/Open pick must not reopen.
    const pinned = firstTurnEgressPin(sessionId);
    return {
      contained: pinned ?? egressAllowlistStore.resolveContained(sessionId),
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
    };
  };
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
  // `runtimeMode` is passed for the anti-framing policy (planning#379): every
  // real deployment refuses to be framed, and the dogfood inner orchestrator
  // (`RUNTIME_MODE=local`) does not, because the outer instance frames it.
  const app = await createOrchestratorApp(undefined, runtimeMode);

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
