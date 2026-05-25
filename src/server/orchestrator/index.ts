import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import fs from "node:fs/promises";
import Docker from "dockerode";
import type { AgentId, DockerMemoryStats } from "../shared/types.js";
import type { WsClientMessage, WsServerMessage, WsLogEntry } from "../shared/types.js";
import { isUnderEvictionPressure } from "./memory-pressure.js";
import { getErrorMessage } from "./validation.js";
import { getGitIdentity } from "./git-config.js";
import { pushToOrigin, isGitAuthError } from "./git-utils.js";
import { isNonFastForwardError } from "./services/git.js";
import type { PrStatusPoller } from "./pr-status-poller.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import { registerPreviewProxy } from "./preview-proxy.js";
import type { ConnectionCtx, RunnerCtx, AppCtx } from "./ws-handlers/types.js";
import * as terminalHandlers from "./ws-handlers/terminal-handlers.js";
import * as miscHandlers from "./ws-handlers/misc-handlers.js";
import * as rollbackHandlers from "./ws-handlers/rollback-handlers.js";
import * as rewindHandlers from "./ws-handlers/rewind-handlers.js";
import * as sendMessageHandlers from "./ws-handlers/send-message.js";
import * as serviceHandlers from "./ws-handlers/service-handlers.js";
import type { ServiceManager } from "./service-manager.js";
import { createPlatformCredentialProvider } from "./platform-credentials.js";
import { registerApiRoutes } from "./api-routes.js";
import type { GitManager } from "../shared/git.js";

// ---- Sub-module imports ----
import type { AppDeps } from "./app-di.js";
import { initializeManagers } from "./app-di.js";
import { readDockerMemoryStats } from "./docker-memory.js";
import { ClaudeLimitsProvider, CodexLimitsProvider } from "./limits/index.js";
import type { LimitsProvider } from "./limits/types.js";
import { LimitsPoller } from "./limits-poller.js";
import {
  setupContainerManager,
  buildRunnerFactory,
  createIdleEnforcer,
  createMissingContainerReconciler,
  createRunnerRegistry,
  createSSE,
  createPrStatusPoller,
  createLogBuffer,
  wireEventHandlers,
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
import { createOomCircuitBreaker } from "./oom-circuit-breaker.js";
import { createSessionLoopDetector } from "./loop-detector.js";
import { createRepoPrefetcher, type RepoPrefetcher } from "./repo-prefetch.js";
import { resolveAgentDockerLimits } from "./session-container.js";
import { runDiskJanitor, pruneSessionVolumes } from "./disk-janitor.js";
import { resolveBuildId } from "./build-id.js";
import { MarketplaceStore } from "./marketplace-store.js";
import { ensureCatalogCloned, getCatalogCacheRoot } from "./services/marketplace.js";

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
 */
export async function buildApp(deps: AppDeps = {}): Promise<FastifyInstance> {
  // Captured once at process startup so the client can render a live
  // uptime badge. This is the user's only signal that "Just Restart"
  // actually bounced the orchestrator — without it, a restart that
  // takes < 5s is invisible.
  const processStartedAt = Date.now();
  const buildId = resolveBuildId();
  const clientDir = path.resolve(process.cwd(), "dist/client");
  // ---- DI: instantiate all managers ----
  const mgrs = await initializeManagers(deps);
  const {
    defaultAgentId, workspaceDir, stateDir, credentialsDir, shouldServeStatic,
    autoPushDebounceMs, sessionsRoot, agentFactory,
    createGitManager, createRepoGit, databaseManager, sessionManager,
    repoStore, chatHistoryManager, usageManager, authManager, codexAuthManager,
    credentialStore, providerAccountManager, agentRegistry, githubAuthManager,
    secretStore, reviewStore, agentReviewStore, generateText,
    isTestMode, runtimeMode,
  } = mgrs;

  const app = Fastify({ logger: false });

  await app.register(fastifyWebsocket);
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50 MB per file
      files: 20,                   // max 20 files per request
    },
  });

  // ---- CORS for dev (client on a different port) ----
  app.addHook("onRequest", (request, reply, done) => {
    const origin = request.headers.origin;
    if (origin) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Credentials", "true");
      reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
    if (request.method === "OPTIONS") {
      reply.status(204).send();
      return;
    }
    done();
  });

  // ---- Container manager (Docker isolation) ----
  const { containerManager, dockerProxyServer } = await setupContainerManager({
    deps, isTestMode, credentialsDir, sessionManager, runtimeMode,
  });

  // ---- Docker instance for memory stats ----
  const dockerForStats = containerManager ? new Docker() : null;

  // ---- Bare repo cache directory ----
  // In local mode (dogfooding), `stateDir` lives outside the visible
  // workspace so the inner orch's repo-cache/dep-cache don't pollute the
  // outer's source tree. Production keeps stateDir = workspaceDir.
  const getBareCacheDir = createBareCacheDirHelper(stateDir);
  const getDepCacheDir = createDepCacheDirHelper(stateDir);

  // ---- Marketplace store (docs/149 — skill install UX) ----
  // App-wide catalog list (Settings → Skills → Discover). v1 ships with one
  // pre-seeded row (the official Claude catalog) and never inserts/deletes
  // after that — v2 adds the add/remove verbs. The background pre-clone is
  // kicked off below, after the route table is registered.
  const marketplaceStore = new MarketplaceStore(databaseManager);
  marketplaceStore.seedIfMissing({
    id: "claude-plugins-official",
    source: { kind: "github", ownerRepo: "anthropics/claude-plugins-official" },
    agentId: "claude",
    autoUpdate: true,
  });

  // ---- SSE (Server-Sent Events) ----
  const { sseClients, sseBroadcast } = createSSE();

  // ---- Log buffer ----
  const { getLogBuffer, clearLogBuffer, broadcastLog } = createLogBuffer();

  // ---- OOM circuit breaker ----
  // One process-local instance shared between the health monitor (which
  // records OOMs and trips the breaker), the runner factory (which refuses
  // to create a container when tripped), the recovery handlers (which
  // reset on user-initiated restart), and the diagnostics endpoint
  // (which surfaces the current state to the panel).
  const oomBreaker = createOomCircuitBreaker();

  // ---- SIGTERM/recreate loop detector ----
  // Process-local instance shared between the health monitor (which
  // records `container_started` events and force-trips the breaker on a
  // loop) and the recovery handlers (which call `forget()` on a
  // user-initiated restart). Hoisted out of `setupContainerHealthMonitoring`'s
  // default parameter so recovery can reach it — resetting the breaker
  // without also clearing the loop detector leaves the trip sticky, since
  // both gate the same runner factory.
  const loopDetector = createSessionLoopDetector();

  // ---- Runner factory ----
  const effectiveRunnerFactory = buildRunnerFactory({ deps, containerManager, credentialsDir, runtimeMode, broadcastLog, oomBreaker });

  // ---- Service manager registry (per-session compose stacks) ----
  const serviceManagers = new Map<string, ServiceManager>();
  /**
   * In-flight `mgr.stop()` promises keyed by sessionId. Used by
   * `setupServiceManager` to serialize compose ops per session — see the
   * `composeStopPromises` doc on RunnerRegistryDeps for the race story.
   */
  const composeStopPromises = new Map<string, Promise<void>>();
  /** Per-session compose warnings/errors for configs without a ServiceManager (e.g. old format). */
  const composeWarnings = new Map<string, string>();
  /** Sessions where compose is not configured in shipit.yaml. */
  const composeNotConfigured = new Set<string>();

  // ---- Latest Docker memory stats (memory pressure cache) ----
  // The periodic stats poller below writes here on every successful read.
  // The idle enforcer reads from here to decide whether to switch into
  // pressure-aware mode (bypass grace period, drop effective maxIdle to 0).
  // A simple holder is enough — we only need the most recent reading and
  // it's overwritten in place every 10s.
  const latestMemoryStats: { value: DockerMemoryStats | null } = { value: null };

  // ---- Session runner registry ----
  // Idle enforcement uses a lazy reference to `runnerRegistry` — the callback
  // only fires when a runner goes idle (always after initialization).
  const registryHolder: { ref: SessionRunnerRegistry | null } = { ref: null };
  const enforceIdleContainerLimit = () => {
    if (registryHolder.ref) {
      createIdleEnforcer({
        containerManager,
        credentialStore,
        runnerRegistry: registryHolder.ref,
        getMemoryStats: () => latestMemoryStats.value,
        sseBroadcast,
        broadcastLog,
      })();
    }
  };

  // Platform credential provider (087 Phase 4) — forwards Claude OAuth /
  // GitHub tokens into compose services that declare `source: platform:*`
  // entries in `x-shipit-secrets`. Built once and shared across all
  // ServiceManagers so token rotation in AuthManager / GitHubAuthManager is
  // picked up on the next compose reconcile without restart.
  //
  // docs/088 Phase 2: also resolves `platform:<mcp-oauth-id>` sources
  // (e.g. `platform:linear_oauth`) from CredentialStore.mcpOAuth so any
  // future compose service can opt into the same Linear/Notion token the
  // agent uses for MCP.
  const platformCredentials = createPlatformCredentialProvider({
    authManager, githubAuthManager, credentialStore,
  });

  // Docker-secrets isolation (087 Phase 1 follow-up) — opt-in via env vars.
  // When `SHIPIT_SECRETS_INTERNAL_DIR` is set, ServiceManager writes secret
  // values to per-secret files under that directory and references them
  // from compose via `secrets: { file: ... }` instead of `env_file:`. The
  // agent container's workspace doesn't see the values.
  //
  // `SHIPIT_SECRETS_HOST_DIR` is the path the Docker daemon (host-side) sees
  // for the same directory — required when the orchestrator runs inside a
  // container, since `file:` references are resolved by the daemon, not the
  // orchestrator. Omit for orchestrator-on-host setups.
  const dockerSecretsConfig = process.env.SHIPIT_SECRETS_INTERNAL_DIR
    ? {
      internalDir: process.env.SHIPIT_SECRETS_INTERNAL_DIR,
      ...(process.env.SHIPIT_SECRETS_HOST_DIR ? { hostDir: process.env.SHIPIT_SECRETS_HOST_DIR } : {}),
      entrypointSourcePath: process.env.SHIPIT_SECRETS_ENTRYPOINT
        ?? "/usr/local/share/shipit/secrets-entrypoint.sh",
    }
    : undefined;

  // docs/149 — lazy holder for the PR status poller. The poller is constructed
  // AFTER the runner registry (depends on it), but the registry's system-turn
  // PR lifecycle hook needs to reach it at runtime. Wired below, after the
  // poller exists.
  const prStatusPollerRef: { ref: PrStatusPoller | null } = { ref: null };
  // docs/149 — same shape as the WS handler's readSystemPrompt, hoisted to
  // app scope so the system-turn hook can read it without per-connection state.
  const readSystemPromptApp = async (): Promise<string | undefined> => {
    try {
      const content = await fs.readFile(path.join(workspaceDir, ".shipit", "system-prompt.md"), "utf-8");
      const trimmed = content.trim();
      return trimmed || undefined;
    } catch { return undefined; }
  };

  const runnerRegistry = createRunnerRegistry({
    effectiveRunnerFactory, sessionManager, createGitManager,
    githubAuthManager, agentFactory, chatHistoryManager,
    autoPushDebounceMs, sseBroadcast, enforceIdleContainerLimit,
    getDepCacheDir, serviceManagers, composeStopPromises, composeWarnings, composeNotConfigured, containerManager,
    credentialStore, secretStore, platformCredentials, runtimeMode, broadcastLog,
    usageManager, authManager,
    ...(dockerSecretsConfig ? { dockerSecretsConfig } : {}),
    ...(credentialsDir ? { credentialsDir } : {}),
    readSystemPrompt: readSystemPromptApp,
    generateText,
    getPrStatusPoller: () => prStatusPollerRef.ref ?? undefined,
  });
  registryHolder.ref = runnerRegistry;

  // ---- Proactive bare-cache git pre-fetch (docs/145) ----
  // Keeps each ready repo's bare cache close to `origin/main` in the
  // background so the claim path can skip its synchronous ~650ms fetch.
  // Disabled in test mode so integration tests stay deterministic (they
  // exercise the synchronous-fetch fallback, which the fakes drive).
  const repoPrefetcher: RepoPrefetcher | null = isTestMode ? null : createRepoPrefetcher({
    repoStore, getBareCacheDir, createRepoGit, githubAuthManager,
  });
  repoPrefetcher?.start();

  // ---- PR Status Poller ----
  const prStatusPoller = createPrStatusPoller({
    deps, githubAuthManager, sessionManager, sseBroadcast,
    runnerRegistry, createRepoGit, getBareCacheDir,
    // Skip the volume-prune fallback in test mode so the poller's
    // auto-archive-on-merge path doesn't shell out to docker from tests.
    pruneSessionVolumes: isTestMode ? undefined : pruneSessionVolumes,
    // On-change pre-fetch: a detected merge moved `main`, so refresh the
    // bare cache now (off the request path) — see docs/145.
    ...(repoPrefetcher ? { onRepoMainAdvanced: (url: string) => repoPrefetcher.prefetchRepo(url) } : {}),
  });
  // docs/149 — fill in the lazy reference that the system-turn PR-lifecycle
  // hook closes over.
  prStatusPollerRef.ref = prStatusPoller;

  // ---- Event wiring (deployment + auth) ----
  wireEventHandlers({
    authManager, codexAuthManager, githubAuthManager, agentRegistry,
    providerAccountManager,
    defaultAgentId, sseBroadcast, credentialsDir, sessionManager,
  });

  // ---- Subscription-limits poller ----
  // One pill per fetchable provider in the header (see
  // docs/135-subscription-limits-badge). Polls every 60s; refreshes a
  // specific provider on its auth-complete event so the pill appears
  // within seconds of sign-in instead of waiting a full tick. Skipped in
  // test mode to keep integration tests deterministic — the providers
  // would otherwise read credential files / fire fetches against
  // api.anthropic.com / chatgpt.com.
  const limitsProviders = new Map<AgentId, LimitsProvider>();
  limitsProviders.set("claude", new ClaudeLimitsProvider({ authManager }));
  // Codex is event-fed, not polled: its numbers arrive as `agent_rate_limits`
  // events from the app-server stream (see CodexLimitsProvider). We keep a
  // typed handle so `recordCodexRateLimits` can push into it.
  const codexLimitsProvider = new CodexLimitsProvider({ codexAuthManager });
  limitsProviders.set("codex", codexLimitsProvider);
  const limitsPoller = !isTestMode
    ? new LimitsPoller({ providers: limitsProviders, sseBroadcast })
    : null;
  if (limitsPoller) {
    authManager.on("auth_complete", () => {
      limitsPoller.markAuthRefreshed("claude");
    });
    codexAuthManager.on("codex_auth_complete", () => {
      limitsPoller.markAuthRefreshed("codex");
    });
    limitsPoller.start();
  }

  /**
   * Push a Codex rate-limit snapshot (from an `agent_rate_limits` event) into
   * the provider and refresh its pill immediately. No-op in test mode (no
   * poller). See `CodexLimitsProvider` and agent-listeners.ts.
   */
  const recordCodexRateLimits: AppCtx["recordCodexRateLimits"] = (session, weekly) => {
    codexLimitsProvider.setRateLimits(session, weekly);
    limitsPoller?.markAuthRefreshed("codex");
  };

  // ---- Session directory creation ----
  const createSessionDir = createSessionDirFactory({
    sessionsRoot, sessionManager,
  });

  // ---- Warm session pool ----
  const { warmSessionForRepo, waitForWarmSession } = createWarmPool({
    repoStore, sessionManager, createRepoGit,
    githubAuthManager, credentialStore, containerManager,
    credentialsDir, getBareCacheDir, getDepCacheDir, createSessionDir, sseBroadcast,
    oomBreaker,
  });

  // ---- Migration: derive RepoStore from existing sessions ----
  const migratedRepoUrls = await runRepoMigration({
    repoStore, sessionManager, getSharedRepoDir: getBareCacheDir,
  });

  // ---- Startup: validate warm sessions + re-warm missing ----
  // `credentialStore` enables the docs/088 Phase 2 MCP OAuth token refresh
  // sweep — see `scheduleStartupTasks` for rationale.
  const startupTimer = scheduleStartupTasks({
    repoStore, sessionManager, chatHistoryManager, usageManager,
    containerManager, getBareCacheDir, warmSessionForRepo, credentialStore,
  }, migratedRepoUrls);

  // SSE endpoint — long-lived HTTP response with text/event-stream
  app.get("/api/events", (request, reply) => {
    const origin = request.headers.origin;
    const headers: Record<string, string> = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    };
    // Allow cross-origin requests in dev (client on different port)
    if (origin) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Credentials"] = "true";
    }
    reply.raw.writeHead(200, headers);

    const client = {
      write: (data: string) => reply.raw.write(data),
      closed: false,
    };
    sseClients.add(client);

    // Send initial state snapshot so the client has data immediately.
    //
    // Ordering matters: the sidebar's "needs attention" indicator is derived
    // from PR/CI status and active-runner state. If we sent `session_list`
    // first, the client would render sidebar items with no PR card data,
    // briefly fall through to the "Waiting for your input" attention reason,
    // and then clear the indicator a tick later when `pr_status` arrived.
    // Send the supporting state (PR status, active runners) before the
    // session list so the very first render of each `SessionItem` already
    // sees its CI/agent state and computes the right attention reason.
    const sessions = sessionManager.list();

    // Active runner sessions so sidebar dots and the "agent running" branch
    // of useAttentionInfo are correct on first paint.
    const activeRunnerSessions: string[] = [];
    for (const session of sessions) {
      const runner = runnerRegistry.get(session.id);
      if (runner?.running) activeRunnerSessions.push(session.id);
    }
    if (activeRunnerSessions.length > 0) {
      client.write(`event: active_runners\ndata: ${JSON.stringify({ sessionIds: activeRunnerSessions })}\n\n`);
    }

    // Current PR statuses so inline cards and sidebar icons are correct on
    // connect — must precede session_list to avoid a one-frame flash of the
    // attention indicator on sessions whose CI is still running.
    const prStatuses = prStatusPoller.getAllStatuses();
    if (prStatuses.length > 0) {
      client.write(`event: pr_status\ndata: ${JSON.stringify({ updates: prStatuses })}\n\n`);
    }

    // GitHub rate-limit state — emit the banner immediately so a refreshed
    // tab knows polling is paused. The poller's normal transition broadcast
    // only fires when the limited flag flips, so a connecting client would
    // miss an in-progress limit without this snapshot.
    const rateLimit = githubAuthManager.getRateLimitState();
    if (rateLimit.limited && (rateLimit.resetAt === null || rateLimit.resetAt > Date.now())) {
      client.write(`event: gh_rate_limited\ndata: ${JSON.stringify({ resetAt: rateLimit.resetAt })}\n\n`);
    }

    client.write(`event: session_list\ndata: ${JSON.stringify({ sessions })}\n\n`);
    const repos = repoStore.list();
    client.write(`event: repo_list\ndata: ${JSON.stringify({ repos })}\n\n`);

    const agents = agentRegistry.list().map((a) => ({
      id: a.id, name: a.name, installed: a.installed,
      authConfigured: a.authConfigured, models: a.capabilities.models,
      supportsReview: a.capabilities.supportsReview,
      supportsSteering: a.capabilities.supportsSteering,
      supportedPermissionModes: a.capabilities.supportedPermissionModes,
    }));
    client.write(`event: agent_list\ndata: ${JSON.stringify({ agents, defaultAgentId })}\n\n`);
    client.write(`event: provider_accounts\ndata: ${JSON.stringify({ accounts: providerAccountManager.list() })}\n\n`);

    // In-flight Codex device-auth flow — replay the pending event so a
    // client that connected after the original broadcast (e.g. page reload
    // while waiting for the user to approve the device code) lands back
    // on the Step 1 / Step 2 view instead of the dead "Sign in" button.
    // The server's `codex login --device-auth` process keeps polling for
    // up to 15 min regardless of WS / SSE lifecycle, so the in-flight
    // state outlives any single browser tab. See feature 119.
    const codexPending = codexAuthManager.getPendingEvent();
    if (codexPending) {
      client.write(`event: codex_auth_pending\ndata: ${JSON.stringify(codexPending)}\n\n`);
    }

    // Process metadata — the client uses processStartedAt to render a
    // live-ticking uptime badge next to the Docker memory badge so the
    // user can confirm that a restart actually happened. Sent once per
    // connect since the value is static for the process lifetime.
    client.write(`event: system_info\ndata: ${JSON.stringify({ processStartedAt, buildId })}\n\n`);

    // Send current Docker memory stats on connect
    if (dockerForStats) {
      void (async () => {
        const stats = await readDockerMemoryStats(dockerForStats);
        if (stats && !client.closed) {
          client.write(`event: docker_memory\ndata: ${JSON.stringify(stats)}\n\n`);
        }
      })();
    }

    // Subscription-limits snapshot — one pill per fetchable provider in
    // the header. May be empty on the very first connect after a
    // restart (the poller's initial tick races SSE connect); the next
    // 60s tick will broadcast a fresh map. See doc 135.
    if (limitsPoller) {
      const snapshot = limitsPoller.getSnapshot();
      if (Object.keys(snapshot).length > 0) {
        client.write(`event: subscription_limits\ndata: ${JSON.stringify({ limits: snapshot })}\n\n`);
      }
    }

    request.raw.on("close", () => {
      client.closed = true;
      sseClients.delete(client);
    });
  });

  // ---- Docker memory stats broadcast (every 10s) ----
  // Also caches the latest reading for the pressure-aware idle enforcer
  // and triggers an immediate eviction pass when usage crosses the
  // eviction threshold. Without the immediate trigger, eviction would
  // wait for the next 30s idle-enforcement tick — long enough for the
  // host to OOM-kill containers underneath us.
  const memoryStatsInterval = dockerForStats ? setInterval(() => {
    void (async () => {
      const stats = await readDockerMemoryStats(dockerForStats);
      if (!stats) return;
      const wasUnderPressure = isUnderEvictionPressure(latestMemoryStats.value);
      latestMemoryStats.value = stats;
      sseBroadcast("docker_memory", stats);
      const nowUnderPressure = isUnderEvictionPressure(stats);
      if (nowUnderPressure && !wasUnderPressure) {
        // Edge-triggered: only fire once per pressure crossing so we don't
        // burn cycles on every poll while pressure persists. The periodic
        // 30s enforcer continues to run with pressure-aware semantics for
        // the duration.
        try { enforceIdleContainerLimit(); }
        catch (err) { console.error("[memory-pressure] immediate eviction failed:", err); }
      }
    })();
  }, 10_000) : null;

  // ---- Periodic idle container cleanup (every 30s) ----
  // Runs the idle enforcer on a fixed cadence so cleanup happens regardless
  // of WebSocket activity. WebSocket close handlers MUST NOT trigger this
  // synchronously — that would couple WS lifecycle to runner/container
  // lifecycle and let transient disconnects kill running agents. The
  // enforcer itself also enforces a grace period (IDLE_GRACE_PERIOD_MS) so
  // a runner whose viewer just detached is not immediately eligible for
  // disposal.
  //
  // The missing-container reconciler runs on the same cadence — it catches
  // runners whose container vanished without a `container_exited` event
  // (Docker daemon restart, missed die event during the health-monitor
  // reconnect window, external `docker rm`). Without it, the session
  // looks stuck forever from the client's perspective.
  const reconcileMissingContainers = containerManager
    ? createMissingContainerReconciler({
        containerManager,
        runnerRegistry,
        broadcastLog,
        // Lets the reconciler re-adopt a live-but-untracked container
        // instead of force-disposing its runner — same resolver shape as
        // the startup `rediscover` path.
        sessionInfoResolver: (sessionId) => {
          const session = sessionManager.get(sessionId);
          if (!session?.workspaceDir) return undefined;
          const limits = resolveAgentDockerLimits(session.workspaceDir);
          return {
            workspaceDir: session.workspaceDir,
            dockerAccess: limits.dockerAccess,
            resourceLimits: limits.dockerAccess ? {
              memory: limits.memoryLimit,
              cpuQuota: limits.cpuQuota,
              pidsLimit: limits.pidsLimit,
            } : undefined,
          };
        },
      })
    : null;
  // Guards against overlapping reconciler passes: the reconciler is async
  // (C3 awaits Docker queries to re-adopt orphaned containers) and a hung
  // Docker daemon can make a pass outlast the 30s interval. Two concurrent
  // passes over `runnerRegistry.ids()` could both decide the same runner is
  // orphaned and race dispose-vs-adopt — so a pass that's still running
  // skips the next tick entirely.
  let reconcileInFlight = false;
  const idleEnforcementInterval = containerManager ? setInterval(() => {
    try {
      enforceIdleContainerLimit();
    } catch (err) {
      console.error("[idle-cleanup] periodic enforcement failed:", err);
    }
    if (reconcileMissingContainers && !reconcileInFlight) {
      // Async since C3 — the reconciler may await a Docker query to
      // re-adopt an orphaned container. Fire-and-forget with a catch so a
      // hung Docker daemon can't wedge the idle-enforcement interval.
      reconcileInFlight = true;
      void reconcileMissingContainers()
        .catch((err: unknown) => {
          console.error("[orphan-runner] periodic reconciliation failed:", err);
        })
        .finally(() => { reconcileInFlight = false; });
    }
  }, 30_000) : null;
  // Don't keep the event loop alive just for idle enforcement — let process
  // shutdown proceed naturally.
  if (idleEnforcementInterval && typeof idleEnforcementInterval.unref === "function") {
    idleEnforcementInterval.unref();
  }

  // ---- Disk janitor (startup-only sweep) ----
  // Reclaims orphan ShipIt-labeled compose volumes, archived session
  // workspaces (opt-in), and unreferenced repo / dep caches. Each item
  // is recovering from a failure earlier in the lifecycle (archive
  // teardown crashed, fs.rm failed, repo removal didn't cascade) — none
  // accumulate steadily, so we run once at boot rather than on a timer.
  // Skipped in test mode so unit tests don't shell out to docker.
  if (!isTestMode) {
    const archivedWorkspaceDays = parseFloat(process.env.DISK_JANITOR_ARCHIVED_WORKSPACE_DAYS ?? "0");
    const cacheDays = parseFloat(process.env.DISK_JANITOR_CACHE_DAYS ?? "30");
    const nmStoreDays = parseFloat(process.env.DISK_JANITOR_NM_STORE_DAYS ?? "14");
    // Fire-and-forget — we don't want the sweep to block first-request
    // latency, and `runDiskJanitor` swallows its own errors (see the
    // module docstring) so there's nothing to await for safety.
    void runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir,
      credentialsDir,
      archivedWorkspaceDays: Number.isFinite(archivedWorkspaceDays) ? archivedWorkspaceDays : 0,
      cacheDays: Number.isFinite(cacheDays) ? cacheDays : 30,
      nmStoreDays: Number.isFinite(nmStoreDays) ? nmStoreDays : 14,
      githubAuthManager,
      createRepoGit,
      getBareCacheDir,
      sweepOrphanBranches: process.env.DISK_JANITOR_ORPHAN_BRANCHES !== "false",
    });
  }

  // ---- HTTP API routes ----
  await registerApiRoutes(app, {
    sessionManager,
    repoStore,
    createGitManager,
    createRepoGit,
    agentRegistry,
    githubAuthManager,
    credentialStore,
    providerAccountManager,
    defaultAgentId,
    workspaceDir,
    stateDir,
    runtimeMode,
    credentialsDir,
    marketplaceStore,
    usageManager,
    runnerRegistry,
    chatHistoryManager,
    authManager,
    codexAuthManager,
    broadcastLog,
    sseBroadcast,
    getSharedRepoDir: getBareCacheDir,
    createSessionDir,
    generateText,
    sessionsRoot,
    warmSessionForRepo,
    waitForWarmSession: (repoUrl: string) => waitForWarmSession(repoUrl),
    ...(repoPrefetcher ? { shouldSkipClaimFetch: (url: string) => repoPrefetcher.coveredRecently(url) } : {}),
    createSessionDirFull: createSessionDir,
    containerManager: containerManager ?? undefined,
    prStatusPoller,
    databaseManager,
    secretStore,
    reviewStore,
    agentReviewStore,
    serviceManagers,
    composeStopPromises,
    // Skip the volume-prune fallback in test mode so unit / integration
    // tests don't shell out to a real Docker daemon. Production always
    // wires this; the function itself is defensive (catches its own
    // errors) so it's safe even when Docker isn't reachable.
    pruneSessionVolumes: isTestMode ? undefined : pruneSessionVolumes,
    getLogBuffer,
    agentFactory,
    oomBreaker,
    loopDetector,
    ...(deps.mcpOAuthFetchImpl !== undefined
      ? { mcpOAuthFetchImpl: deps.mcpOAuthFetchImpl }
      : {}),
  });

  // ---- Marketplace pre-clone (docs/149) ----
  // Fire-and-forget background fetch of every seeded catalog so the Discover
  // tab opens instantly the first time a user clicks it (the common case).
  // Skipped in test mode so unit / integration tests don't hit GitHub.
  if (!isTestMode) {
    const cacheRoot = getCatalogCacheRoot(stateDir);
    for (const mkt of marketplaceStore.list()) {
      void ensureCatalogCloned(marketplaceStore, mkt.id, cacheRoot).catch((err: unknown) => {
        // `ensureCatalogCloned` already records `fetch-failed` on the row;
        // the Discover tab renders a Retry button against that state.
        console.warn(
          `[marketplace] pre-clone failed for ${mkt.id}:`,
          (err as Error).message,
        );
      });
    }
  }

  // ---- Preview reverse proxy (container mode) ----
  if (containerManager) {
    registerPreviewProxy(app, { containerManager, serviceManagers, runnerRegistry });
  }

  // ---- Test-only session creation endpoint ----
  // Replaces the removed POST /api/sessions for integration tests.
  if (isTestMode) {
    app.post<{ Body: { title?: string } }>(
      "/api/_test/sessions",
      async (_request) => {
        const title = _request.body?.title?.trim() || "Test session";
        const { appSessionId, sessionDir, workspaceDir } = await createSessionDir(title);
        const git = createGitManager(workspaceDir);
        await git.init();
        return { sessionId: appSessionId, sessionDir, workspaceDir };
      },
    );

    // Test-only: simulate idle cleanup. Production triggers this via the
    // periodic timer + IDLE_GRACE_PERIOD_MS check inside createIdleEnforcer.
    // Tests want the same outcome (registry entry gone, runner disposed)
    // without waiting on real timers.
    app.post<{ Params: { sessionId: string } }>(
      "/api/_test/dispose-runner/:sessionId",
      async (request, reply) => {
        const { sessionId } = request.params;
        const runner = runnerRegistry.get(sessionId);
        if (!runner) {
          reply.code(404);
          return { error: "Runner not found" };
        }
        runnerRegistry.dispose(sessionId, { force: true });
        return { ok: true };
      },
    );

    // Test-only: read runner state from the registry. Lets tests assert on
    // viewerCount, running, lastViewerDetachAt without coupling to the WS
    // protocol.
    app.get<{ Params: { sessionId: string } }>(
      "/api/_test/runner/:sessionId",
      async (request, reply) => {
        const { sessionId } = request.params;
        const runner = runnerRegistry.get(sessionId);
        if (!runner) {
          reply.code(404);
          return { error: "Runner not found" };
        }
        return {
          viewerCount: runner.viewerCount,
          running: runner.running,
          lastViewerDetachAt: runner.lastViewerDetachAt,
          disposed: runner.disposed,
          queueLength: runner.queueLength,
        };
      },
    );

    // Test-only: ensure a runner exists and force its `running` flag. Lets
    // tests assert guards that depend on agent-in-progress state (e.g. the
    // merge endpoint's 409) without driving a full WS turn.
    app.post<{ Params: { sessionId: string }; Body: { running?: unknown } }>(
      "/api/_test/runner/:sessionId/running",
      async (request, reply) => {
        const { sessionId } = request.params;
        const session = sessionManager.get(sessionId);
        if (!session?.workspaceDir) {
          reply.code(404);
          return { error: "Session not found or has no workspaceDir" };
        }
        const runner = runnerRegistry.getOrCreate(sessionId, session.workspaceDir, defaultAgentId);
        runner.running = request.body?.running === true;
        return { ok: true, running: runner.running };
      },
    );
  }

  // Serve the built client files from dist/client/
  if (shouldServeStatic) {
    try {
      await app.register(fastifyStatic, {
        root: clientDir,
        prefix: "/",
        wildcard: false,
      });
      // SPA fallback — serve index.html for non-file routes
      app.setNotFoundHandler((_req, reply) => {
        reply.sendFile("index.html", clientDir);
      });
    } catch {
      // Client build may not exist during dev; that's fine
      console.log("[server] No built client found at", clientDir);
    }
  }

  // ---- Per-session WebSocket route ----



  // ---- Per-session WebSocket route ----
  // Session-scoped WS: auto-activates the session on connect, no activate_session needed.
  // The session ID is in the URL path. Agent preference via ?agent= query param.
  app.get<{ Params: { sessionId: string }; Querystring: { agent?: string; model?: string } }>(
    "/ws/sessions/:sessionId",
    { websocket: true },
    (socket, request) => {
      const { sessionId } = request.params;
      const session = sessionManager.get(sessionId);
      if (!session) {
        socket.close(4004, "Session not found");
        return;
      }
      console.log(`[ws] session client connected: ${sessionId}`);

      // Per-connection state — initialized from URL params
      let activeAppSessionId: string | undefined = sessionId;
      let activeSessionDir: string | null = session.workspaceDir ?? null;
      const requestedAgent = request.query.agent as AgentId | undefined;
      const requestedModel = request.query.model;
      // Prefer the session's own persisted choices over the URL params (which
      // come from the client's global localStorage and would otherwise let a
      // model/agent pick in one session leak into others on reconnect).
      let perConnectionAgentId: AgentId = session.agentId ?? requestedAgent ?? defaultAgentId;
      let selectedModel: string | undefined = session.model ?? requestedModel;
      // Reconcile agent ↔ model. They come from INDEPENDENT sources (agent:
      // session/default/param; model: session or the localStorage-derived
      // query param), so they can diverge — most often a stale `agent=codex`
      // riding in alongside the user's real `model=opus` pick. The product
      // rule (docs/142 C): the model is the user's only real control, so for a
      // session that is NOT yet pinned to an agent the **model is
      // authoritative** — derive the agent that owns it. This is the
      // server-side guard against the Opus→gpt-5.5 switch: the model wins and
      // the session runs Claude. Once the session is pinned (its agent's creds
      // were provisioned on the first turn) the agent is locked, so we flip to
      // agent-authoritative and conform the model to it instead.
      {
        const model = selectedModel;
        const modelOwner = model
          ? agentRegistry.list().find((a) => a.capabilities.models.includes(model))
          : undefined;
        if (!session.agentPinned && modelOwner) {
          perConnectionAgentId = modelOwner.id;
        } else {
          const agentInfo = agentRegistry.get(perConnectionAgentId);
          if (selectedModel && agentInfo && !agentInfo.capabilities.models.includes(selectedModel)) {
            selectedModel = agentInfo.capabilities.models[0];
          }
        }
      }
      // Lock in the choices on connect so future reconnects ignore the global
      // localStorage values (`selectedModel` already prefers `session.model`
      // over the query param). While the session is unpinned, keep the
      // persisted agent in sync with the model-derived choice — a model change
      // before the first turn re-derives the agent on the next connect, and an
      // incoherent legacy (agent, model) pair self-heals. After pinning,
      // `session.agentId` is immutable.
      if (!session.agentPinned && perConnectionAgentId !== session.agentId) {
        try { sessionManager.setAgentId(sessionId, perConnectionAgentId); } catch { /* ignore */ }
      }
      if (selectedModel && selectedModel !== session.model) {
        try { sessionManager.setModel(sessionId, selectedModel); } catch { /* ignore */ }
      }
      let attachedRunner: SessionRunnerInterface | null = null;
      let runnerMessageListener: ((msg: WsServerMessage) => void) | null = null;
      let previewRetryListener: ((msg: WsServerMessage) => void) | null = null;

      const send = (msg: WsServerMessage) => {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify(msg));
        }
      };

      // ---- Runner attach/detach (same as /ws) ----
      const attachToRunner = (runner: SessionRunnerInterface) => {
        if (attachedRunner === runner) return;
        detachFromRunner();
        attachedRunner = runner;
        runnerMessageListener = (msg: WsServerMessage) => { send(msg); };
        runner.on("message", runnerMessageListener);
        runner.attachViewer();
        // Reopen the PR-status poller's gate. The supervisor was paused if
        // the user closed every tab; a viewer is now back. activateSession
        // will follow with a forceRefreshSession so the freshness is
        // immediate — this just keeps the supervisor running for subsequent
        // ticks. See docs/064 "Polling budget."
        prStatusPoller.notifyViewerAttached();
        // Don't replay the turn event buffer here — persisted chat history is
        // loaded via HTTP (loadSessionHistory) and is the single source of truth.
        // Replaying buffer events races with the HTTP load and causes duplicates
        // or overwritten messages.  Live events stream via the "message" listener.
        if (runner.getQueueSnapshot().length > 0) {
          send({ type: "queue_updated", queue: runner.getQueueSnapshot() });
        }
        if (runner.running || runner.queueLength > 0) {
          send({ type: "session_status", sessionId: runner.sessionId, running: runner.running, queueLength: runner.queueLength });
        }
        // Replay current service/compose state so the UI is correct after reload
        const mgr = serviceManagers.get(runner.sessionId);
        if (mgr) {
          if (mgr.startError) {
            send({
              type: "compose_error",
              sessionId: runner.sessionId,
              message: mgr.startError,
            } as WsServerMessage);
          }
          const services = mgr.getServices();
          if (services.length > 0) {
            send({
              type: "service_list",
              sessionId: runner.sessionId,
              services: services.map(s => ({
                name: s.name,
                status: s.status,
                port: s.port,
                preview: s.preview,
                error: s.error,
              })),
            } as WsServerMessage);
          }
        }
        // Replay compose warnings (e.g. old-format migration hints) when no
        // ServiceManager exists — the warning was stored before the WS listener
        // was attached, so emitMessage couldn't deliver it.
        const warning = composeWarnings.get(runner.sessionId);
        if (warning && !mgr) {
          send({
            type: "compose_error",
            sessionId: runner.sessionId,
            message: warning,
          } as WsServerMessage);
        }
        // Replay compose-not-configured hint so the preview panel shows
        // the setup prompt after page reload.
        if (!mgr && !warning && composeNotConfigured.has(runner.sessionId)) {
          send({
            type: "compose_not_configured",
            sessionId: runner.sessionId,
          } as WsServerMessage);
        }
        // Don't send preview_status here — it's sent once after the log
        // buffer replay (see below) so React 18 batching can't swallow it.
        // For container runners where preview state isn't yet known (SSE
        // still connecting), register a one-shot listener that sends it
        // once the worker reports its preview state.
        if (!runner.previewStatusKnown) {
          previewRetryListener = (msg: WsServerMessage) => {
            if (msg.type === "preview_status") {
              runner.off("message", previewRetryListener!);
              previewRetryListener = null;
            }
          };
          runner.on("message", previewRetryListener);
        }
      };

      const detachFromRunner = () => {
        if (attachedRunner) {
          if (runnerMessageListener) attachedRunner.off("message", runnerMessageListener);
          if (previewRetryListener) attachedRunner.off("message", previewRetryListener);
          attachedRunner.detachViewer();
          // Arm the PR-status poller's grace timer so the supervisor pauses
          // itself if no one reconnects within the disconnect grace window.
          // The poller decides — it knows whether any other viewer / runner /
          // autonomous flow keeps the gate open.
          prStatusPoller.notifyViewerDetached();
        }
        attachedRunner = null;
        runnerMessageListener = null;
        previewRetryListener = null;
      };

      const scheduleAutoPush = (git: GitManager, sessionId?: string) => {
        // Look up the runner from the registry by session ID instead of using
        // the connection-scoped attachedRunner. If the WS reconnects during an
        // agent turn, attachedRunner on the old connection becomes null and the
        // push would be silently skipped.
        const runner = (sessionId ? runnerRegistry.get(sessionId) : null) ?? attachedRunner;
        if (!runner) return;
        runner.clearPushTimer();
        runner.setPushTimer(setTimeout(async () => {
          runner.setPushTimer(null);
          try {
            if (!githubAuthManager.authenticated) return;
            const branch = await pushToOrigin(git);
            if (branch) {
              runner.emitMessage({ type: "github_push_result", success: true, message: `Auto-pushed to origin/${branch}`, branch });
              // A push just landed → CI is about to register. Bump this
              // session's repo to fast cadence for the post-push window so
              // the first non-none check is observed quickly. The poller
              // re-arms the supervisor if the gate was already open
              // (a closed tab keeps the supervisor paused; the user will
              // see fresh data on their next visit via forceRefreshSession).
              prStatusPoller.notifyAutoPush(runner.sessionId);
            }
          } catch (err) {
            if (isNonFastForwardError(err)) {
              // Branch has diverged — emit event so client can offer rebase
              runner.emitMessage({
                type: "git_push_rejected",
                reason: "non_fast_forward",
                message: "Branch has diverged from remote. Rebase needed to update.",
              });
              return;
            }
            const errMsg = getErrorMessage(err);
            // Token expired/revoked — mark the stored credential invalid so
            // the SSE broadcast clears the GitHub auth state on every
            // connected client and surfaces a toast pointing back to
            // Settings → GitHub. Without this the failure would only be
            // visible as a "log_entry" in the session's Logs panel — the
            // same swallow-in-the-logs path the user complained about.
            if (isGitAuthError(err)) {
              const invalidated = await githubAuthManager.markTokenInvalid(`auto-push failed: ${errMsg}`);
              const text = invalidated
                ? "Auto-push failed: your GitHub token is invalid or expired. Sign in again in Settings → GitHub."
                : `Auto-push failed: ${errMsg}`;
              broadcastLog(runner.sessionId, "server", text);
              runner.emitMessage({ type: "log_entry", source: "server", text, timestamp: new Date().toISOString() });
              return;
            }
            const text = errMsg.includes("workflow")
              ? "Auto-push failed: your GitHub token needs the `workflow` scope to push changes to GitHub Actions workflow files. Update your token at https://github.com/settings/tokens."
              : `Auto-push failed: ${errMsg}`;
            broadcastLog(runner.sessionId, "server", text);
            runner.emitMessage({ type: "log_entry", source: "server", text, timestamp: new Date().toISOString() });
          }
        }, autoPushDebounceMs));
      };

      const getActiveDir = (): string => activeSessionDir ?? workspaceDir;
      const getActiveGitManager = (): GitManager => {
        if (!activeSessionDir) throw new Error("No active session — git operations require a session");
        return createGitManager(activeSessionDir);
      };

      const activateSession = async (sid: string) => {
        const s = sessionManager.get(sid);
        activeAppSessionId = sid;
        const dir = s?.workspaceDir ?? null;
        // The session's persisted agent is authoritative. A runner is seeded
        // with the global default agent at creation (warm pool, container
        // recovery), and the real choice is meant to be applied on WS
        // connect — see RecoveryDeps.defaultAgentId. activateSession is that
        // application point: without it, getActiveAgentId() returns the
        // runner's stale agent (e.g. claude) while the model is the session's
        // (e.g. gpt-5.5), spawning `claude --model gpt-5.5` which the CLI
        // rejects as "issue with the selected model". Don't disturb a runner
        // mid-turn.
        const sessionAgentId = s?.agentId ?? perConnectionAgentId;
        const existingRunner = runnerRegistry.get(sid);
        if (existingRunner) {
          if (!existingRunner.running && existingRunner.agentId !== sessionAgentId) {
            existingRunner.agentId = sessionAgentId;
          }
          attachToRunner(existingRunner);
        } else if (dir) {
          const runner = runnerRegistry.getOrCreate(sid, dir, sessionAgentId);
          attachToRunner(runner);
        } else {
          detachFromRunner();
        }
        if (dir !== activeSessionDir) {
          activeSessionDir = dir;
        }
        if (s?.remoteUrl) {
          prStatusPoller.trackSession(sid, s.remoteUrl);
          void prStatusPoller.forceRefreshSession(sid).catch((err: unknown) => {
            console.error(`[pr-poller] Error on session-activated refresh ${sid}:`, err);
          });
        }
        if (dir) void checkGitIdentity(dir);
      };

      const checkGitIdentity = async (_sessionDir: string) => {
        if (getGitIdentity()) return;
        send({ type: "git_identity_required" });
      };

      const readSystemPrompt = async (): Promise<string | undefined> => {
        try {
          const content = await fs.readFile(path.join(workspaceDir, ".shipit", "system-prompt.md"), "utf-8");
          const trimmed = content.trim();
          return trimmed || undefined;
        } catch { return undefined; }
      };

      // Wrap broadcastLog so it both buffers (per-session) AND sends to attached WS viewers.
      // The sessionId is captured from the URL — every log line emitted on
      // this connection belongs to this session, so it goes into THIS
      // session's buffer only. This is what isolates one session's terminal
      // panel from another session's logs.
      const sessionBroadcastLog = (source: WsLogEntry["source"], text: string) => {
        broadcastLog(sessionId, source, text); // per-session buffer
        const entry: WsLogEntry = { type: "log_entry", source, text, timestamp: new Date().toISOString() };
        if (attachedRunner) {
          attachedRunner.emitMessage(entry);
        } else {
          send(entry);
        }
      };

      // ---- Handler context ----
      // RunnerCtx no longer exposes setters that delegate to attachedRunner.
      // Handlers resolve the runner via `resolveRunner(ctx)` (in
      // ws-handlers/resolve-runner.ts) and mutate `runner.X` directly. This
      // makes WS-disconnect-driven bugs structurally impossible — a handler
      // either has a runner reference (and can mutate it) or doesn't (and
      // returns/no-ops explicitly). See feature 095.
      const ctx: ConnectionCtx & RunnerCtx & AppCtx & serviceHandlers.ServiceCtx = {
        send, broadcastLog: sessionBroadcastLog, sseBroadcast,
        getActiveDir, getActiveGitManager,
        getActiveAppSessionId: () => activeAppSessionId,
        setActiveAppSessionId: (id) => { activeAppSessionId = id; },
        getActiveSessionDir: () => activeSessionDir,
        setActiveSessionDir: (dir) => { activeSessionDir = dir; },
        activateSession,
        agentFactory: (agentId: AgentId) => {
          const r = attachedRunner ?? runnerRegistry.get(sessionId) ?? null;
          if (r?.createAgent) return r.createAgent(agentId);
          if (agentFactory) return agentFactory(agentId);
          throw new Error("No agent factory available");
        },
        getActiveAgentId: () => (attachedRunner ?? runnerRegistry.get(sessionId))?.agentId ?? perConnectionAgentId,
        setActiveAgentId: (id) => {
          perConnectionAgentId = id;
          const r = attachedRunner ?? runnerRegistry.get(sessionId);
          if (r) r.agentId = id;
        },
        getSelectedModel: () => selectedModel,
        setSelectedModel: (m) => { selectedModel = m; },
        clearLogBuffer: () => { clearLogBuffer(sessionId); },
        getRunner: () => attachedRunner,
        getRunnerRegistry: () => runnerRegistry,
        attachToRunner, detachFromRunner,
        sessionManager, chatHistoryManager, createGitManager, createRepoGit,
        githubAuthManager,
        usageManager, authManager, agentRegistry, credentialStore, providerAccountManager,
        repoStore, warmSessionForRepo, generateText,
        getSharedRepoDir: getBareCacheDir, checkGitIdentity, readSystemPrompt, scheduleAutoPush,
        prStatusPoller,
        recordCodexRateLimits,
        getSubscriptionLimitsSnapshot: () => limitsPoller?.getSnapshot() ?? {},
        refreshSubscriptionLimits: limitsPoller
          ? (agentId) => limitsPoller.triggerProviderRefresh(agentId)
          : undefined,
        workspaceDir, sessionsRoot, defaultAgentId, credentialsDir,
        getServiceManager: () => serviceManagers.get(sessionId) ?? null,
      };

      // Auto-activate the session on connect
      void activateSession(sessionId);

      // Send log buffer and git identity check.
      // Replay only THIS session's buffered entries so a newly-connected
      // viewer doesn't see logs that belong to other sessions.
      //
      // Send `clear_logs` first so reconnecting viewers replace their local
      // terminal store with the server buffer (the source of truth) instead
      // of appending the replay on top of the entries they already have.
      // Without this, every WS reconnect (network blip, tab visibility flip,
      // session re-attach) would duplicate the buffered log lines in the UI.
      send({ type: "clear_logs" });
      const logBuffer = getLogBuffer(sessionId);
      for (const entry of logBuffer) { send(entry); }
      if (!getGitIdentity()) { send({ type: "git_identity_required" }); }

      // Send preview_status after the log buffer so it's the last
      // synchronous message.  Sending it earlier (inside attachToRunner)
      // caused React 18 automatic batching to swallow it when many WS
      // messages arrived in the same rendering cycle.
      {
        const runner = runnerRegistry.get(sessionId);
        if (runner?.previewStatusKnown) {
          send(runner.buildPreviewStatus());
        }
      }

      // Always send PR lifecycle card for sessions with a remote.
      // The SSE pr_status snapshot handles open/merged PRs; this covers the
      // "ready" phase (branch info + diff stats, no PR created yet).
      {
        const session = sessionManager.get(sessionId);
        if (session?.remoteUrl && session.workspaceDir && session.branchRenamed) {
          const prStatus = prStatusPoller.getStatus(sessionId);
          if (!prStatus && !session.mergedAt) {
            // No open/merged PR and not already merged — send branch info and diff stats
            void (async () => {
              try {
                const git = createGitManager(session.workspaceDir!);
                const headBranch = session.branch || await git.getCurrentBranch();
                const { insertions, deletions } = await git.diffStatVsBranch("main");
                send({
                  type: "pr_lifecycle_update",
                  sessionId,
                  cardId: `pr-card-${sessionId}`,
                  phase: "ready",
                  headBranch,
                  totalInsertions: insertions,
                  totalDeletions: deletions,
                });
              } catch (err) {
                send({
                  type: "pr_lifecycle_update",
                  sessionId,
                  cardId: `pr-card-${sessionId}`,
                  phase: "error",
                  errorMessage: err instanceof Error ? err.message : "Failed to read git status",
                });
              }
            })();
          }
        }
      }

      // Message dispatcher — same as /ws but without new_session and activate_session
      // A single client message → its handler. Kept as a local fn so the
      // message listener can `await` it inside a try/catch. Subtlety: the cases
      // below `return handler(...)` a promise; a try/catch wrapped directly
      // around `return promise` would NOT catch a rejection (the function
      // returns before the promise settles). Awaiting the returned promise here
      // is what lets the listener catch it. A handler rejection — most often a
      // WorkerTimeoutError from a wedged session worker (e.g. /terminal/start) —
      // must degrade to a per-session error, never escape as an unhandled
      // rejection that crashes the whole orchestrator.
      const dispatchSessionMessage = (msg: WsClientMessage): void | Promise<void> => {
        switch (msg.type) {
          case "terminal_start": return terminalHandlers.handleTerminalStart(ctx, msg);
          case "terminal_input": return terminalHandlers.handleTerminalInput(ctx, msg);
          case "terminal_resize": return terminalHandlers.handleTerminalResize(ctx, msg);
          case "clear_logs": { terminalHandlers.handleClearLogs(ctx); return; }
          case "set_agent": {
            const agentId = msg.agentId;
            // docs/138 — once the session has taken its first turn the agent is
            // pinned for life: its credentials were provisioned into the
            // per-session credentials dir and the other agent's creds are
            // deliberately absent. Reject any switch to a *different* agent
            // (re-selecting the same one is a harmless no-op). This is the
            // authoritative guard; the UI also disables the picker on an active
            // session as defense-in-depth.
            if (activeAppSessionId) {
              const pinnedSession = sessionManager.get(activeAppSessionId);
              if (pinnedSession?.agentPinned && pinnedSession.agentId && pinnedSession.agentId !== agentId) {
                send({
                  type: "error",
                  message: `This session is locked to ${pinnedSession.agentId} and the agent can't be changed after the first message.`,
                });
                return;
              }
            }
            const info = agentRegistry.get(agentId);
            if (!info) { send({ type: "error", message: `Unknown agent: ${agentId}` }); return; }
            if (!info.installed) { send({ type: "error", message: `${info.name} CLI is not installed` }); return; }
            if (!info.authConfigured) {
              const envKey = agentId === "codex" ? "OPENAI_API_KEY" : "";
              send({ type: "error", message: `${envKey || "API key"} is not set. Add it in Settings → Agents.` });
              return;
            }
            ctx.setActiveAgentId(agentId);
            // Conform the model to the new agent. The AgentPicker switches the
            // agent without touching the model, so without this a Codex →
            // Claude switch would leave a "gpt-5.5" model selected and the next
            // turn would spawn `claude --model gpt-5.5` and fail. Fall back to
            // the new agent's default model when the current one isn't in its
            // lineup.
            const currentModel = ctx.getSelectedModel();
            if (currentModel && !info.capabilities.models.includes(currentModel)) {
              const fallbackModel = info.capabilities.models[0];
              ctx.setSelectedModel(fallbackModel);
              if (activeAppSessionId) {
                sessionManager.setModel(activeAppSessionId, fallbackModel);
              }
            }
            // Persist per-session so reconnects don't pick up the global
            // localStorage agent from another session.
            if (activeAppSessionId) {
              sessionManager.setAgentId(activeAppSessionId, agentId);
            }
            return;
          }
          case "set_model": {
            const currentAgentId = ctx.getActiveAgentId();
            const activeAgent = agentRegistry.get(currentAgentId);
            if (activeAgent && !activeAgent.capabilities.models.includes(msg.model)) {
              // The model isn't in the current agent's lineup. The grouped
              // model picker switches agent + model together by firing
              // `set_agent` then `set_model`, so this fires whenever the user
              // crosses an agent boundary (e.g. Codex → Opus). Rather than
              // depend on `set_agent` having already landed — which it may not
              // have, if its auth/install guard bailed or the two messages
              // raced — make `set_model` self-healing: if an installed+authed
              // agent owns this model, switch to it here. Only error when no
              // available agent can run the model.
              const owner = agentRegistry.available().find(
                (a) => a.capabilities.models.includes(msg.model),
              );
              if (!owner) {
                send({ type: "error", message: `Model "${msg.model}" is not available for ${activeAgent.name}` });
                return;
              }
              if (owner.id !== currentAgentId) {
                // docs/138 — after the session has taken its first turn the
                // agent is pinned for life (per-agent credential isolation).
                // The model can still move freely within the pinned agent's
                // lineup, but a cross-agent model is rejected here rather
                // than triggering the silent auto-switch the unpinned flow
                // uses. The UI mirrors this by greying out cross-agent rows
                // in the picker; this branch is the authoritative guard.
                if (activeAppSessionId) {
                  const pinnedSession = sessionManager.get(activeAppSessionId);
                  if (pinnedSession?.agentPinned) {
                    send({
                      type: "error",
                      message: `This session is locked to ${activeAgent.name}. Model "${msg.model}" requires ${owner.name}, which can't be selected after the first message. Switch models within ${activeAgent.name} instead.`,
                    });
                    return;
                  }
                }
                ctx.setActiveAgentId(owner.id);
                if (activeAppSessionId) {
                  sessionManager.setAgentId(activeAppSessionId, owner.id);
                }
              }
            }
            ctx.setSelectedModel(msg.model);
            // Persist to session metadata so it survives reconnects and warm pool
            if (activeAppSessionId) {
              sessionManager.setModel(activeAppSessionId, msg.model);
            }
            return;
          }
          // new_session and activate_session are NOT handled — session is implicit from URL
          case "rollback_code": return rollbackHandlers.handleRollbackCode(ctx, msg);
          case "rollback_code_and_chat": return rollbackHandlers.handleRollbackCodeAndChat(ctx, msg);
          case "fork_session_from_message": return rollbackHandlers.handleForkSessionFromMessage(ctx, msg);
          case "rewind_at_gap": return rollbackHandlers.handleRewindAtGap(ctx, msg);
          case "rewind_preview_request": return rollbackHandlers.handleRewindPreviewRequest(ctx, msg);
          case "rewind_restore_request": return rollbackHandlers.handleRewindRestoreRequest(ctx, msg);
          case "rewind_to_message": return rewindHandlers.handleRewindToMessage(ctx, msg);
          case "cancel_queued_message": { miscHandlers.handleCancelQueuedMessage(ctx, msg); return; }
          case "interrupt_agent": { miscHandlers.handleInterruptAgent(ctx); return; }
          case "pr_tab_active": { miscHandlers.handlePrTabActive(ctx, msg); return; }
          case "init_preview_config": {
            void sendMessageHandlers.handleSendMessage(ctx, {
              type: "send_message",
              text: `Analyze this project and set up live preview using Docker Compose.

1. Create a \`docker-compose.yml\` at the workspace root with a service for the dev server.
2. Create a \`shipit.yaml\` at the workspace root to configure the agent and install steps.

Example docker-compose.yml for a Node.js project:
\`\`\`yaml
services:
  web:
    image: node:20
    working_dir: /app
    volumes:
      - .:/app
    ports:
      - "3000:3000"
    command: npm run dev
\`\`\`

Example shipit.yaml:
\`\`\`yaml
version: 1
agent:
  install:
    - npm install
compose:
  file: docker-compose.yml
\`\`\`

Look at package.json scripts, framework config files, and project structure
to determine the correct dev command, ports, and install steps.
Read /shipit-docs/compose.md for full details on the compose model.`,
            });
            return;
          }
          case "start_service": return serviceHandlers.handleStartService(ctx, msg);
          case "stop_service": return serviceHandlers.handleStopService(ctx, msg);
          case "subscribe_service_logs": { serviceHandlers.handleSubscribeServiceLogs(ctx, msg); return; }
          case "send_message": return sendMessageHandlers.handleSendMessage(ctx, msg);
          case "send_review_message": return sendMessageHandlers.handleSendReviewMessage(ctx, msg);
          case "answer_question": return sendMessageHandlers.handleAnswerQuestion(ctx, msg);
        }
      };

      socket.on("message", async (raw: Buffer) => {
        let msg: WsClientMessage;
        try { msg = JSON.parse(raw.toString()) as WsClientMessage; } catch { send({ type: "error", message: "Invalid JSON" }); return; }
        try {
          await dispatchSessionMessage(msg);
        } catch (err) {
          // A handler threw or rejected — degrade to a per-session error.
          // Never let it bubble to an unhandled rejection: a worker HTTP
          // timeout (WorkerTimeoutError on /terminal/start) previously took
          // down the whole orchestrator this way.
          console.error(`[ws] handler error for "${msg.type}" (session ${sessionId}):`, err);
          try {
            send({ type: "error", message: err instanceof Error ? err.message : "Request failed" });
          } catch { /* socket may already be closed */ }
        }
      });

      socket.on("close", () => {
        console.log(`[ws] session client disconnected: ${sessionId}`);
        detachFromRunner();
        // Intentionally do NOT call enforceIdleContainerLimit() here.
        // WebSocket lifecycle MUST NOT affect runner/container lifecycle —
        // a transient disconnect (network blip, reload, session switch)
        // should never kill the agent or destroy the container. Idle
        // cleanup runs on a periodic timer plus on `runner_idle` events.
      });
    },
  );

  // ---- Container health monitoring ----
  if (containerManager) {
    setupContainerHealthMonitoring(containerManager, runnerRegistry, broadcastLog, loopDetector, oomBreaker);
  }

  // Graceful shutdown
  app.addHook("onClose", async () => {
    if (memoryStatsInterval) clearInterval(memoryStatsInterval);
    if (idleEnforcementInterval) clearInterval(idleEnforcementInterval);
    if (limitsPoller) limitsPoller.stop();
    if (repoPrefetcher) repoPrefetcher.stop();
  });
  registerShutdownHook(app, {
    startupTimer, authManager, codexAuthManager, runnerRegistry,
    dockerProxyServer, containerManager, databaseManager,
  });

  return app;
}

// Only start the server when this file is the entry point (not when imported by tests).
// Vitest sets process.env.VITEST; alternatively check import.meta.url vs process.argv[1].
if (!process.env.VITEST) {
  void autoStart(buildApp);
}
