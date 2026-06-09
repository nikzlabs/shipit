import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import fs from "node:fs/promises";
import Docker from "dockerode";
import type { AgentId, DockerMemoryStats } from "../shared/types.js";
import { getAuthEnvKey } from "../shared/agent-registry.js";
import type { WsClientMessage, WsServerMessage, WsLogEntry } from "../shared/types.js";
import { isUnderEvictionPressure } from "./memory-pressure.js";
import { getErrorMessage } from "./validation.js";
import { getGitIdentity } from "./git-config.js";
import { pushToOrigin, isGitAuthError } from "./git-utils.js";
import { isNonFastForwardError } from "./services/git.js";
import type { PrStatusPoller } from "./pr-status-poller.js";
import { ReleaseStatusPoller } from "./release-status-poller.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { SessionManager } from "./sessions.js";
import type { ChatHistoryManager } from "./chat-history.js";
import type { UsageManager } from "./usage.js";
import { registerPreviewProxy } from "./preview-proxy.js";
import type { ConnectionCtx, RunnerCtx, AppCtx } from "./ws-handlers/types.js";
import * as terminalHandlers from "./ws-handlers/terminal-handlers.js";
import * as miscHandlers from "./ws-handlers/misc-handlers.js";
import * as rollbackHandlers from "./ws-handlers/rollback-handlers.js";
import * as sendMessageHandlers from "./ws-handlers/send-message.js";
import * as bugReportHandlers from "./ws-handlers/bug-report-handlers.js";
import * as issueWriteHandlers from "./ws-handlers/issue-write-handlers.js";
import * as serviceHandlers from "./ws-handlers/service-handlers.js";
import type { ServiceManager } from "./service-manager.js";
import { registerApiRoutes } from "./api-routes.js";
import type { GitManager } from "../shared/git.js";

// ---- Sub-module imports ----
import type { AppDeps } from "./app-di.js";
import { initializeManagers } from "./app-di.js";
import { readDockerMemoryStats } from "./docker-memory.js";
import { buildAgentRuntime } from "./agents/index.js";
import { LimitsRegistry } from "./limits-registry.js";
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
import { runDiskJanitor, pruneSessionVolumes, escalateDiskTiers, statfsFreeBytes, statfsTotalBytes, resolveDiskWatermarks } from "./disk-janitor.js";
import { ClaudeOAuthRefresher } from "./agents/claude/oauth-refresher.js";
import { CodexOAuthRefresher } from "./agents/codex/oauth-refresher.js";
import { repushAgentToken, repushProviderAccountToken } from "./session-credentials.js";
import { resolveBuildId, resolveVersion } from "./build-id.js";
import { getUpdateMode } from "./services/updates.js";
import { readChannel } from "./release-channel.js";
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
  const effectiveRunnerFactory = buildRunnerFactory({ deps, containerManager, credentialsDir, sessionManager, runtimeMode, broadcastLog, oomBreaker });

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

  // docs/184: compose services no longer receive the user's platform-managed
  // credentials (Claude OAuth / GitHub token / MCP OAuth). The
  // `source: platform:*` forwarding path was removed because it handed the
  // user's global identity to attacker-controlled service code on the
  // strength of a repo-committed compose file. Compose services now get only
  // user-supplied secrets from the secret store.

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

  // docs/183 — service-only secret isolation. By default, per-service compose
  // env files are written to `<stateDir>/service-env/<sessionId>/.env.<svc>`,
  // OUTSIDE the agent's workspace mount, instead of the agent-readable
  // workspace `.shipit/.env.<svc>`. In containerized runtime `stateDir`
  // defaults to the workspace-volume root, and the agent mounts only the
  // `sessions/<id>/workspace` subpath, so this directory is outside the
  // agent's view (see docs/183 §"Why <stateDir>/service-env is agent-invisible").
  // `SHIPIT_SERVICE_ENV_DIR` overrides the root for operators who keep
  // `stateDir` somewhere the safety assertion would reject. Docker-secrets
  // mode (above) takes priority over this when configured.
  const serviceEnvDir = process.env.SHIPIT_SERVICE_ENV_DIR
    ?? path.join(stateDir, "service-env");

  // docs/149 — lazy holder for the PR status poller. The poller is constructed
  // AFTER the runner registry (depends on it), but the registry's system-turn
  // PR lifecycle hook needs to reach it at runtime. Wired below, after the
  // poller exists.
  const prStatusPollerRef: { ref: PrStatusPoller | null } = { ref: null };

  // docs/153 / docs/154 — lazy holders for orchestrator-owned OAuth
  // refreshers. Constructed below (after `wireEventHandlers` so
  // `repushTokenToPinnedSessions` is in scope), referenced from the
  // runner-registry's listener deps (built first) via forward refs so the
  // auth-required hooks resolve to live instances at runtime. Stay `null` in
  // test mode / local runtime.
  //
  // docs/153 — lazy holder for the Claude OAuth refresher. Constructed below
  // (after `wireEventHandlers` so `repushTokenToPinnedSessions` is in scope),
  // referenced from the runner-registry's listener deps (built first) via this
  // forward ref so `nudgeClaudeOAuthRefresh` resolves to the live instance at
  // runtime. Stays `null` in test mode / local runtime.
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
  /**
   * docs/155 — per-agent dispatch for the WS `auth_required` handler. Each
   * backend that needs a side effect on auth failure registers itself here;
   * the listener calls `onAgentAuthRequired(agentId)` without knowing which
   * agent it is. Adding a backend with its own hook (e.g. Codex device-flow
   * restart) means one `set()` here.
   */
  const agentAuthRequiredHooks = new Map<AgentId, () => void>();
  agentAuthRequiredHooks.set("claude", nudgeClaudeOAuthRefresh);
  agentAuthRequiredHooks.set("codex", nudgeCodexOAuthRefresh);
  const onAgentAuthRequired = (agentId: AgentId): void => {
    agentAuthRequiredHooks.get(agentId)?.();
  };
  /**
   * docs/179 — proactively heal an agent's OAuth source token before someone
   * reads it (session start, AI session naming, the 401 auto-retry). Keyed by
   * agent like {@link onAgentAuthRequired}: Claude registers the refresher's
   * `ensureFresh` (a no-op when the token is healthy, an awaited single-flight
   * refresh when it's within the safety margin). Codex's auth is unaffected by
   * the rotating-refresh-token stampede, so it registers no hook and resolves
   * to a no-op. Returns `true` when the token is usable after the call.
   */
  const ensureTokenFreshHooks = new Map<AgentId, (accountId?: string) => Promise<boolean>>();
  ensureTokenFreshHooks.set("claude", async (accountId?: string): Promise<boolean> => {
    const r = claudeOAuthRefresherRef.ref;
    // No refresher (test / local runtime) → nothing this path can heal. Return
    // false: the proactive callers ignore the boolean (they fail open and just
    // proceed), while the runtime-401 auto-retry reads it as "couldn't heal" and
    // correctly surfaces the sign-in card instead of pointlessly re-dispatching.
    if (!r) return false;
    try {
      return await r.ensureFresh(accountId);
    } catch (err) {
      console.error("[claude-oauth-refresh] ensureFresh failed:", err);
      return false;
    }
  });
  const ensureAgentTokenFresh = async (agentId: AgentId, accountId?: string): Promise<boolean> => {
    const hook = ensureTokenFreshHooks.get(agentId);
    return hook ? hook(accountId) : true;
  };
  // docs/149 — same shape as the WS handler's readSystemPrompt, hoisted to
  // app scope so the system-turn hook can read it without per-connection state.
  const readSystemPromptApp = async (): Promise<string | undefined> => {
    try {
      const content = await fs.readFile(path.join(workspaceDir, ".shipit", "system-prompt.md"), "utf-8");
      const trimmed = content.trim();
      return trimmed || undefined;
    } catch { return undefined; }
  };

  // docs/155 Phase 5 — per-agent runtime tables. `buildAgentRuntime()` lives in
  // `agents/index.ts` and assembles every `Map<AgentId, …>` lookup the
  // orchestrator consumes (auth managers for shutdown / limits rearm / SSE,
  // limits providers for `recordAgentRateLimits`, run-params preps for the
  // shared run-params assembler, system-prompt fragments for
  // `agent-instructions.ts`). Adding a backend = one new folder under
  // `agents/<id>/` + one entry per table inside `buildAgentRuntime()`.
  const agentRuntime = buildAgentRuntime({ authManager, codexAuthManager });
  const { authManagers, limitsProviders, runParamsPreps } = agentRuntime;

  // docs/150 — let the provider-account manager drive account-scoped login
  // flows through the per-provider auth managers (built just above).
  providerAccountManager.attachAuthManagers(authManagers);

  const runnerRegistry = createRunnerRegistry({
    effectiveRunnerFactory, sessionManager, repoStore, createGitManager,
    githubAuthManager, agentFactory, chatHistoryManager,
    autoPushDebounceMs, sseBroadcast, enforceIdleContainerLimit,
    getDepCacheDir, serviceManagers, composeStopPromises, composeWarnings, composeNotConfigured, containerManager,
    credentialStore, secretStore, runtimeMode, broadcastLog,
    usageManager, authManager, authManagers, runParamsPreps,
    nudgeClaudeOAuthRefresh,
    onAgentAuthRequired,
    ensureAgentTokenFresh,
    ...(dockerSecretsConfig ? { dockerSecretsConfig } : {}),
    serviceEnvDir,
    ...(credentialsDir ? { credentialsDir } : {}),
    readSystemPrompt: readSystemPromptApp,
    generateText,
    getPrStatusPoller: () => prStatusPollerRef.ref ?? undefined,
    // docs/146 — same lazy-resolution pattern as the poller itself: the
    // manager is constructed inside the poller's constructor, which runs
    // after the registry, so the runner-idle hook reads through a getter.
    getAutoConflictResolveManager: () => prStatusPollerRef.ref?.autoConflictResolveManager,
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

  const drainQueueForSession = (sessionId: string): void => {
    const runner = runnerRegistry.get(sessionId);
    if (!runner || runner.running || runner.queueLength === 0) return;
    const next = runner.dequeue();
    if (!next) return;
    runner.emitMessage({ type: "queue_updated", queue: runner.getQueueSnapshot() });
    runner.dispatch({
      text: next.text,
      ...(next.activity !== undefined ? { activity: next.activity } : {}),
      ...(next.images !== undefined ? { images: next.images } : {}),
      ...(next.files !== undefined ? { files: next.files } : {}),
      ...(next.uploads !== undefined ? { uploads: next.uploads } : {}),
      ...(next.permissionMode !== undefined ? { permissionMode: next.permissionMode } : {}),
      ...(next.reviewFilePath !== undefined ? { reviewFilePath: next.reviewFilePath } : {}),
    });
  };

  // ---- PR Status Poller ----
  const prStatusPoller = createPrStatusPoller({
    deps, githubAuthManager, sessionManager, sseBroadcast,
    runnerRegistry, createRepoGit, createGitManager, getBareCacheDir,
    // Skip the volume-prune fallback in test mode so the poller's
    // auto-archive-on-merge path doesn't shell out to docker from tests.
    pruneSessionVolumes: isTestMode ? undefined : pruneSessionVolumes,
    // Destroy each archived session's container so its workspace bind mount
    // is released before fs.rm runs — see archiveSession docblock.
    containerManager,
    // On-change pre-fetch: a detected merge moved `main`, so refresh the
    // bare cache now (off the request path) — see docs/145.
    ...(repoPrefetcher ? { onRepoMainAdvanced: (url: string) => repoPrefetcher.prefetchRepo(url) } : {}),
    // docs/146 — collaborators needed to construct the auto-resolve callback.
    // The closure inside `createPrStatusPoller` builds `RebaseDriverDeps`
    // per-session from these shared managers. (`createGitManager` is already
    // passed above for the diff-stats override.)
    chatHistoryManager,
    usageManager,
    authManager,
    credentialStore,
    drainQueueForSession,
    ...(agentFactory ? { agentFactory } : {}),
  });
  // docs/149 — fill in the lazy reference that the system-turn PR-lifecycle
  // hook closes over.
  prStatusPollerRef.ref = prStatusPoller;

  // ---- Release Status Poller (docs/171) ----
  // Reflects the inline release lifecycle card: gate/CI status + the published
  // GitHub Release, off the agent-pushed tag. Reuses the PR poller's global gate
  // shape (viewers / detach grace / active release).
  const releaseStatusPoller = new ReleaseStatusPoller({
    githubAuth: githubAuthManager,
    sseBroadcast,
    runnerRegistry,
  });

  // ---- Event wiring (deployment + auth) ----
  // `authManagers` map is built above the runner-registry construction (see
  // docs/155 Phase 2) so system-turn listeners can pick it up.
  wireEventHandlers({
    authManagers,
    githubAuthManager, agentRegistry,
    providerAccountManager,
    sseBroadcast, credentialsDir, sessionManager,
  });

  // ---- Claude OAuth refresher (docs/153) ----
  //
  // The orchestrator becomes the single entity that refreshes Claude OAuth
  // tokens, eliminating the multi-session refresh stampede that was 429'ing
  // every session ~8h after fresh auth (see docs/153 §Root cause). Skipped in
  // test mode (no real auth, no per-session containers) and in local runtime
  // (dogfood — no per-session containers either). The refresher iterates
  // every Claude account, propagates a rotated token to all pinned sessions
  // for that account via `repushProviderAccountToken` (or
  // `repushAgentToken` for legacy sessions whose `provider_route_*` is null).
  if (!isTestMode) {
    const repushOAuthAccountToken = (logPrefix: string) => (agentId: AgentId, accountId: string): void => {
      let healed = 0;
      for (const session of sessionManager.list()) {
        if (!session.agentPinned || session.agentId !== agentId) continue;
        // Match either route-aware sessions pinned to this account, or legacy
        // (null route) sessions which still resolve to the source via the
        // legacy `.claude/.credentials.json` symlink that the provider-account
        // migration stamped on disk.
        const accountMatches =
          (session.providerRouteKind === "account" && session.providerRouteId === accountId) ||
          (session.providerRouteKind === null || session.providerRouteKind === undefined);
        if (!accountMatches) continue;
        try {
          const wrote =
            session.providerRouteKind === "account" && session.providerRouteId
              ? repushProviderAccountToken(credentialsDir, session.id, agentId, session.providerRouteId)
              : repushAgentToken(credentialsDir, session.id, agentId);
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
    // Rearm immediately on a fresh sign-in. `wireEventHandlers` also listens
    // to this event for its own bookkeeping; EventEmitter supports multiple
    // handlers so the two coexist without ordering constraints.
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
    codexOAuthRefresherRef.ref = codexRefresher;
    codexRefresher.start();
    authManagers.get("codex")?.on("complete", () => {
      codexRefresher.refreshNow().catch((err: unknown) => {
        console.error("[codex-oauth-refresh] post-auth refresh failed:", err);
      });
    });
  }

  // ---- Subscription-limits poller ----
  // One pill per fetchable provider in the header (see
  // docs/135-subscription-limits-badge). Both Claude and Codex are
  // event-fed: their numbers arrive on the agent's stream
  // (`rate_limit_event` for Claude, `account/rateLimits/updated` for Codex)
  // and the orchestrator routes them through `recordAgentRateLimits` into
  // the matching provider (built above in `buildAgentRuntime()`). Skipped in
  // test mode to keep integration tests deterministic.
  const limitsRegistry = !isTestMode
    ? new LimitsRegistry({ providers: limitsProviders, sseBroadcast })
    : null;
  if (limitsRegistry) {
    // One subscription per backend, keyed off the auth-manager map built
    // above. Adding a new agent picks this up for free. The normalized
    // `complete` event fires alongside each backend's legacy
    // `auth_complete` / `codex_auth_complete` emit so existing per-agent SSE
    // wiring is untouched. (docs/155 Phase 2)
    for (const [agentId, mgr] of authManagers) {
      mgr.on("complete", () => {
        limitsRegistry.markAuthRefreshed(agentId);
        // docs/161 — seed one `/api/oauth/usage` baseline per sign-in so the
        // Claude pill shows a low-usage number without waiting for the user to
        // click refresh. Self-skips if an API snapshot already exists and is a
        // no-op for providers without an on-demand path (Codex).
        void limitsRegistry.refreshNow(agentId, "seed");
      });
    }
  }

  /**
   * Push a fresh rate-limit snapshot for any agent into its provider and
   * refresh the badge immediately. The dispatch is a one-line lookup against
   * the `limitsProviders` map built above — adding a new backend means one
   * `Map.set()` at construction, not a new branch here. (docs/155)
   * No-op for unknown agents and in test mode (no registry).
   */
  const recordAgentRateLimits: AppCtx["recordAgentRateLimits"] = (agentId, session, weekly) => {
    limitsProviders.get(agentId)?.setRateLimits(session, weekly);
    limitsRegistry?.markAuthRefreshed(agentId);
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
    //
    // This snapshot is AUTHORITATIVE and must always be sent — even when no
    // runner is active (empty array). The client replaces its active-runner
    // set wholesale from this event, so suppressing it when empty would leave
    // a stale "running" flag in place after a reconnect. That matters on
    // mobile: when the tab is backgrounded the SSE socket dies silently and
    // the client never sees `session_agent_finished`, so a session that
    // finished while hidden stays marked running. On foreground we force a
    // fresh connection (see useServerEvents) and rely on this snapshot to
    // clear it. A stale running flag is doubly bad because
    // `computeAttentionReason` short-circuits to null while a session is
    // "running", which also masks that session's CI-failed / PR attention.
    const activeRunnerSessions: string[] = [];
    for (const session of sessions) {
      const runner = runnerRegistry.get(session.id);
      if (runner?.running) activeRunnerSessions.push(session.id);
    }
    client.write(`event: active_runners\ndata: ${JSON.stringify({ sessionIds: activeRunnerSessions })}\n\n`);

    // Current PR statuses so inline cards and sidebar icons are correct on
    // connect — must precede session_list to avoid a one-frame flash of the
    // attention indicator on sessions whose CI is still running.
    //
    // Sent with `isSnapshot: true` so the client reconciles authoritatively:
    // it replaces its poller-derived PR state with exactly this set and drops
    // any stale entries it still holds for sessions absent here (e.g. a PR
    // that merged/closed while the tab was backgrounded, whose incremental
    // removal the dead socket missed). Always sent — even when empty — so a
    // reconnect can clear everything if the server now knows of no PRs.
    const prStatuses = prStatusPoller.getAllStatuses();
    client.write(`event: pr_status\ndata: ${JSON.stringify({ updates: prStatuses, isSnapshot: true })}\n\n`);

    // docs/171 — current release lifecycle cards so an inline release card
    // survives a reconnect. Snapshot semantics mirror pr_status.
    const releaseStatuses = releaseStatusPoller.getAllStatuses();
    client.write(`event: release_status\ndata: ${JSON.stringify({ updates: releaseStatuses, isSnapshot: true })}\n\n`);

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
      supportsCompaction: a.capabilities.supportsCompaction,
      supportedPermissionModes: a.capabilities.supportedPermissionModes,
      skillInvocationPrefix: a.capabilities.skillInvocationPrefix,
    }));
    client.write(`event: agent_list\ndata: ${JSON.stringify({ agents })}\n\n`);
    client.write(`event: provider_accounts\ndata: ${JSON.stringify({ accounts: providerAccountManager.list() })}\n\n`);

    // In-flight per-agent auth flows — replay each backend's pending payload
    // so a client that connected after the original broadcast (e.g. page
    // reload while waiting for the user to approve a sign-in) lands back on
    // the live sign-in card instead of the dead "Sign in" button. Each
    // backend's CLI keeps running regardless of WS / SSE lifecycle (Codex
    // device-flow polls for up to 15 min; Claude OAuth PTY stays alive
    // until completion), so the in-flight state outlives any single tab.
    // Driven by the auth-manager map — adding a backend that wants replay
    // is one `getPendingPayload()` implementation. (docs/155 Phase 2b)
    for (const [agentId, mgr] of authManagers) {
      const details = mgr.getPendingPayload();
      if (details) {
        client.write(`event: agent_auth_pending\ndata: ${JSON.stringify({ agentId, details })}\n\n`);
      }
    }

    // Process metadata — the client uses processStartedAt to render a
    // live-ticking uptime badge next to the Docker memory badge so the
    // user can confirm that a restart actually happened. Sent once per
    // connect since the value is static for the process lifetime.
    client.write(`event: system_info\ndata: ${JSON.stringify({ processStartedAt, buildId, version, updateMode })}\n\n`);

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
    // the header. Both providers are event-fed, so the map is empty until
    // the first turn on each backend delivers a `rate_limit_event` /
    // `account/rateLimits/updated`. See doc 135.
    if (limitsRegistry) {
      const snapshot = limitsRegistry.getSnapshot();
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
    // Pace between destructive ops so the (fire-and-forget) sweep drips out
    // instead of bursting `docker` spawns + git pushes that contend with a
    // concurrent agent start for the Docker daemon / bare-cache git layer. This
    // is why we DON'T defer the sweep off the boot window — throttling flattens
    // the spike wherever it lands instead of relocating it to a later, more
    // disruptive moment mid-session.
    const janitorPaceMs = parseFloat(process.env.DISK_JANITOR_PACE_MS ?? "");
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
      paceMs: Number.isFinite(janitorPaceMs) ? janitorPaceMs : 500,
      githubAuthManager,
      createRepoGit,
      getBareCacheDir,
      sweepOrphanBranches: process.env.DISK_JANITOR_ORPHAN_BRANCHES !== "false",
    });
  }

  // docs/161 Part 2 — disk-tier escalation. Fired async after each session
  // activation (never on the start critical path). This is the PRIMARY
  // steady-state reclaim of the idle node_modules tail: prod deploys manually,
  // so the startup janitor above runs rarely, but session starts are frequent
  // and are exactly when disk gets consumed. Guarded + fire-and-forget;
  // `escalateDiskTiers` swallows its own errors.
  const idleLightMs = parseFloat(process.env.DISK_IDLE_LIGHT_MS ?? "") || undefined;
  const idleEvictMs = parseFloat(process.env.DISK_IDLE_EVICT_MS ?? "") || undefined;
  const idleEvictMergedMs = parseFloat(process.env.DISK_IDLE_EVICT_MERGED_MS ?? "") || undefined;
  // Pace between age-based tier descents for the same reason as the janitor:
  // keep the steady-state node_modules reclaim from monopolizing the Docker
  // daemon a concurrent agent start needs. Deliberately NOT applied to the
  // disk-pressure LRU descent — when the box is critically low and starts are
  // already failing, fast reclaim is the point.
  const escalationPaceMsRaw = parseFloat(process.env.DISK_ESCALATION_PACE_MS ?? "");
  const escalationPaceMs = Number.isFinite(escalationPaceMsRaw) ? escalationPaceMsRaw : 500;
  // Disk-pressure watermarks: explicit *_BYTES win (backward compat); otherwise
  // derive fraction-of-disk *_PCT × total host disk size (portable across host
  // disk sizes — self-hosters can't be expected to know the right byte count).
  // Total is a fixed property of the host filesystem, so probe it once here
  // rather than on every escalation pass.
  const diskTotalBytes = isTestMode ? null : await statfsTotalBytes(stateDir);
  const { diskFreeLow, diskFreeHigh } = resolveDiskWatermarks({
    lowBytes: parseFloat(process.env.DISK_FREE_LOW_BYTES ?? "") || undefined,
    highBytes: parseFloat(process.env.DISK_FREE_HIGH_BYTES ?? "") || undefined,
    lowPct: parseFloat(process.env.DISK_FREE_LOW_PCT ?? "") || undefined,
    highPct: parseFloat(process.env.DISK_FREE_HIGH_PCT ?? "") || undefined,
    totalBytes: diskTotalBytes,
  });
  // issue #1048 — surface that the disk-pressure safety net is off. When
  // neither watermark resolves (no *_BYTES / *_PCT configured, or a *_PCT
  // was set but the host total couldn't be probed), the LRU-under-pressure
  // descent in `escalateDiskTiers` no-ops, leaving only the age-based ladder.
  // One line at startup makes that visible instead of silently degraded.
  if (!isTestMode && (diskFreeLow === undefined || diskFreeHigh === undefined)) {
    console.warn(
      "[disk-janitor] disk-pressure eviction is DISABLED — set DISK_FREE_LOW_PCT/DISK_FREE_HIGH_PCT "
      + "(or DISK_FREE_LOW_BYTES/DISK_FREE_HIGH_BYTES) to enable the under-pressure LRU descent. "
      + "Age-based tier escalation still runs.",
    );
  }
  const kickDiskEscalation = (excludeSessionId?: string): void => {
    if (isTestMode || !containerManager) return;
    void escalateDiskTiers(
      {
        sessionManager,
        runnerRegistry,
        serviceManagers,
        containerManager,
        pruneVolumes: (sid) => pruneSessionVolumes(sid),
        createGitManager,
        idleLightMs,
        idleEvictMs,
        idleEvictMergedMs,
        paceMs: escalationPaceMs,
        diskFreeLow,
        diskFreeHigh,
        getFreeDiskBytes: () => statfsFreeBytes(stateDir),
      },
      excludeSessionId,
    );
  };
  // Startup safety net: run one pass now so a long-idle tail left by a
  // manually-deployed (rarely-restarted) prod box gets reclaimed even before
  // the first session activation. The per-activation kicks above are the
  // primary steady-state reclaim.
  kickDiskEscalation();

  // ---- Periodic disk-tier escalation (issue #1049) ----
  // The ESCALATION ladder (and its disk-pressure LRU descent) is the one disk
  // task that accumulates steadily — idle node_modules pile up with the clock,
  // not with a failure earlier in the lifecycle. The other side, the startup
  // `runDiskJanitor` failure-recovery sweeps, correctly stay startup-only (see
  // the disk-janitor.ts module docstring) because those orphans only appear
  // when teardown crashed, so a timer there would mostly burn cycles.
  //
  // Until now escalation only fired at orchestrator boot and after each session
  // start, which created a self-heal feedback trap: once the disk fills, new
  // session starts FAIL → the per-start kick never fires → the reclaim that
  // would free space never runs. A quiet period with no starts also let idle
  // node_modules sit well past the 24h `hot → light` step unreclaimed. This
  // low-frequency timer makes both the age-based reclaim AND the disk-pressure
  // check run even when the instance is quiet or wedged, independent of session
  // activity. Mirrors `kickDiskEscalation`'s own `!isTestMode && containerManager`
  // no-op guard, so in test mode the interval is never created.
  const diskEscalationIntervalMs = parseFloat(process.env.DISK_ESCALATION_INTERVAL_MS ?? "")
    || 3_600_000; // hourly
  const diskEscalationInterval = (!isTestMode && containerManager)
    ? setInterval(() => { kickDiskEscalation(); }, diskEscalationIntervalMs)
    : null;
  // Don't keep the event loop alive just for the periodic reclaim — match the
  // idle-enforcement / memory-stats intervals.
  if (diskEscalationInterval && typeof diskEscalationInterval.unref === "function") {
    diskEscalationInterval.unref();
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
    ensureAgentTokenFresh,
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
    authManagers,
    runParamsPreps,
    broadcastLog,
    sseBroadcast,
    ...(limitsRegistry
      ? {
          refreshSubscriptionLimits: (agentId: AgentId, reason: "manual" | "seed") =>
            limitsRegistry.refreshNow(agentId, reason),
        }
      : {}),
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
    // docs/164 — disable the bug-report Stage-2 LLM pass in test mode so
    // integration tests don't shell out to a real agent CLI; production omits
    // this and the route derives the per-session CLI runner.
    ...(isTestMode ? { bugReportModelRunner: async () => null } : {}),
    getLogBuffer,
    agentFactory,
    oomBreaker,
    loopDetector,
    ...(deps.mcpOAuthFetchImpl !== undefined
      ? { mcpOAuthFetchImpl: deps.mcpOAuthFetchImpl }
      : {}),
    ...(deps.trackerFetchImpl !== undefined
      ? { trackerFetchImpl: deps.trackerFetchImpl }
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
          // Size of the post-turn replay buffer. A terminal turn (result,
          // error, interrupt) must leave this at 0 so a reconnect doesn't
          // re-emit a completed turn (docs/163).
          turnEventBufferSize: runner.getTurnEventBuffer().length,
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
      // Prefer the session's own persisted choices over the URL params. The
      // query params come from the client's GLOBAL localStorage (the viewer's
      // last-used model, plus the agent derived from it), so they describe
      // "what this browser last ran", NOT "what this session is". They are only
      // a legitimate source of a *new* choice for a session that has not been
      // pinned to an agent yet — i.e. a warm session whose first turn (this very
      // WS connect) graduates it.
      //
      // Once a session is pinned (quick/child/fork pin at creation; any session
      // pins after its first turn) its agent is immutable and its model is owned
      // by the session row. Consulting the global params for a pinned session is
      // exactly what let a freshly-created quick session silently adopt the
      // viewer's *previously used* model/agent instead of the one it was created
      // with: a quick session is pinned at creation but its model row is only
      // written when an explicit model was sent, so a missing row let the global
      // `requestedModel` leak in and (because pinned) get conformed to the
      // agent's first model. So for a pinned session we ignore the params
      // entirely and fall back to the pinned agent's default model when the row
      // carries none (docs/142 Problem C; quick-session regression).
      let perConnectionAgentId: AgentId;
      let selectedModel: string | undefined;
      if (session.agentPinned) {
        perConnectionAgentId = session.agentId ?? defaultAgentId;
        const agentInfo = agentRegistry.get(perConnectionAgentId);
        selectedModel = session.model ?? agentInfo?.capabilities.models[0];
        // Self-heal an incoherent legacy row whose model the pinned agent can't run.
        if (selectedModel && agentInfo && !agentInfo.capabilities.models.includes(selectedModel)) {
          selectedModel = agentInfo.capabilities.models[0];
        }
      } else {
        const requestedAgent = request.query.agent as AgentId | undefined;
        const requestedModel = request.query.model;
        perConnectionAgentId = session.agentId ?? requestedAgent ?? defaultAgentId;
        selectedModel = session.model ?? requestedModel;
        // Reconcile agent ↔ model for an as-yet-unpinned (warm) session. They
        // come from INDEPENDENT sources, so they can diverge — most often a
        // stale `agent=codex` riding in alongside the user's real `model=opus`
        // pick. The product rule (docs/142 C): the model is the user's only real
        // control, so the **model is authoritative** — derive the agent that
        // owns it. This is the server-side guard against the Opus→gpt-5.5 switch.
        const model = selectedModel;
        const modelOwner = model
          ? agentRegistry.list().find((a) => a.capabilities.models.includes(model))
          : undefined;
        if (modelOwner) {
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
        // docs/161 — bump the viewer clock so the disk-idle ladder treats a
        // recently-opened session as warm. Read ONLY by the ladder (via
        // `max(lastUsedAt, lastViewedAt)`); deliberately NOT `last_used_at`,
        // which the listing predicate keys off — bumping that here would
        // promote a merely-opened merged session to Active forever.
        sessionManager.setLastViewedAt(runner.sessionId);
        // Reopen the PR-status poller's gate. The supervisor was paused if
        // the user closed every tab; a viewer is now back. activateSession
        // will follow with a forceRefreshSession so the freshness is
        // immediate — this just keeps the supervisor running for subsequent
        // ticks. See docs/064 "Polling budget."
        prStatusPoller.notifyViewerAttached();
        releaseStatusPoller.notifyViewerAttached();
        // Replay only the part of the turn buffer that has not already been
        // folded into HTTP chat history. Codex can stream assistant text for a
        // long stretch before a tool-result/final persistence boundary; when a
        // backgrounded tab reconnects, HTTP history may therefore be stale. The
        // client queues these early agent events until its history load
        // completes, then applies them on top of that baseline.
        //
        // `terminal_output` / `terminal_exit` / `terminal_reconnecting` are
        // deliberately skipped: xterm.js keeps its own scrollback across WS
        // reconnects (the component stays mounted), so replaying these here
        // appends the same bytes onto a buffer the client already has — the
        // user sees the prior session output repeated. Fresh terminal mounts
        // and orchestrator↔container SSE reconnects have their own dedicated
        // replay paths (`terminal_start` handler + `onSseOpen`) that prefix
        // with `\x1bc` to keep xterm.js renderer state coherent.
        for (const buffered of runner.getTurnEventBuffer().slice(runner.lastPersistedBufferIndex)) {
          if (buffered.type === "log_entry") continue;
          if (buffered.type === "terminal_output") continue;
          if (buffered.type === "terminal_exit") continue;
          if (buffered.type === "terminal_reconnecting") continue;
          send(buffered);
        }
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
        // Replay agent-emitted presentations (docs/093) so the Present tab
        // hydrates from the runner's authoritative cache. Without this, a tab
        // opened after the `present` tool fired — or re-opened after a session
        // switch — would show nothing, since the live `present_content` stream
        // it relies on already passed. `present_state` is a silent sync: it
        // does NOT bump the unseen badge or auto-switch the panel.
        if (runner.presentations && runner.presentations.length > 0) {
          send({
            type: "present_state",
            sessionId: runner.sessionId,
            presentations: runner.presentations,
          });
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
          releaseStatusPoller.notifyViewerDetached();
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
          // docs/161 — a `light` session kept its checkout but had its deps
          // dropped; booting the runner re-materializes node_modules via the
          // normal `agent.install` / dep-cache path, so selecting it IS the
          // restore. Flip the tier back to `hot` now that we're bringing it up.
          // (`evicted` is restored separately by `unarchiveSession`, which
          // re-clones — it never reaches this branch with a live workspace.)
          if (s?.diskTier === "light") {
            sessionManager.setDiskTier(sid, "hot");
          }
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
        // docs/161 — after the session is up and the user has control, kick a
        // background disk-tier escalation pass over the OTHER idle sessions
        // (this one is excluded + guarded anyway). Never awaited — adds no
        // latency to activation.
        kickDiskEscalation(sid);
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
        usageManager, authManager, authManagers, runParamsPreps, agentRegistry, credentialStore, providerAccountManager,
        ...(deps.trackerFetchImpl !== undefined ? { trackerFetchImpl: deps.trackerFetchImpl } : {}),
        repoStore, warmSessionForRepo, generateText,
        getSharedRepoDir: getBareCacheDir, checkGitIdentity, readSystemPrompt, scheduleAutoPush,
        prStatusPoller,
        releaseStatusPoller,
        recordAgentRateLimits,
        getSubscriptionLimitsSnapshot: () => limitsRegistry?.getSnapshot() ?? {},
        nudgeClaudeOAuthRefresh,
        onAgentAuthRequired,
        ensureAgentTokenFresh,
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
              const envKey = getAuthEnvKey(agentId);
              send({ type: "error", message: `${envKey ?? "API key"} is not set. Add it in Settings → Agents.` });
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
          case "rewind_at_gap": return rollbackHandlers.handleRewindAtGap(ctx, msg);
          case "rewind_preview_request": return rollbackHandlers.handleRewindPreviewRequest(ctx, msg);
          case "rewind_restore_request": return rollbackHandlers.handleRewindRestoreRequest(ctx, msg);
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
          case "subscribe_service_logs": return serviceHandlers.handleSubscribeServiceLogs(ctx, msg);
          case "send_message": {
            // docs/146 — WS-typed user input resets the auto-resolve attempt
            // budget. Only fired from the dispatch switch (not inside the
            // handler) so synthetic `init_preview_config` invocations of
            // handleSendMessage do NOT reset.
            const sessionIdForReset = ctx.getActiveAppSessionId();
            if (sessionIdForReset) {
              prStatusPoller.resetRemediationForUserActivity(sessionIdForReset);
            }
            return sendMessageHandlers.handleSendMessage(ctx, msg);
          }
          case "send_review_message": {
            const sessionIdForReset = ctx.getActiveAppSessionId();
            if (sessionIdForReset) {
              prStatusPoller.resetRemediationForUserActivity(sessionIdForReset);
            }
            return sendMessageHandlers.handleSendReviewMessage(ctx, msg);
          }
          case "answer_question": {
            const sessionIdForReset = ctx.getActiveAppSessionId();
            if (sessionIdForReset) {
              prStatusPoller.resetRemediationForUserActivity(sessionIdForReset);
            }
            return sendMessageHandlers.handleAnswerQuestion(ctx, msg);
          }
          case "submit_bug_report": return bugReportHandlers.handleSubmitBugReport(ctx, msg);
          case "undo_issue_write": return issueWriteHandlers.handleUndoIssueWrite(ctx, msg);
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
    setupContainerHealthMonitoring(containerManager, runnerRegistry, broadcastLog, loopDetector, oomBreaker, chatHistoryManager);
  }

  // Graceful shutdown
  app.addHook("onClose", async () => {
    if (memoryStatsInterval) clearInterval(memoryStatsInterval);
    if (idleEnforcementInterval) clearInterval(idleEnforcementInterval);
    if (diskEscalationInterval) clearInterval(diskEscalationInterval);
    if (repoPrefetcher) repoPrefetcher.stop();
    claudeOAuthRefresherRef.ref?.stop();
    codexOAuthRefresherRef.ref?.stop();
  });
  registerShutdownHook(app, {
    startupTimer, authManagers, runnerRegistry,
    dockerProxyServer, containerManager, databaseManager,
  });

  // docs/146 — minimal test-surface decorations. Integration tests need
  // direct access to the wired collaborators (poller's auto-resolve
  // manager, runner registry, shared managers) to drive flows that bypass
  // the GraphQL polling layer. Production code does NOT read from these —
  // routes / WS handlers consume the references through their own closures
  // / DI. Adding them here just lets tests stop reaching through
  // module-private state.
  app.decorate("prStatusPoller", prStatusPoller);
  app.decorate("releaseStatusPoller", releaseStatusPoller);
  app.decorate("runnerRegistry", runnerRegistry);
  app.decorate("sessionManager", sessionManager);
  app.decorate("chatHistoryManager", chatHistoryManager);
  app.decorate("usageManager", usageManager);

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    /** docs/146 — test-surface decoration. See `index.ts`. */
    prStatusPoller?: PrStatusPoller;
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
