import path from "node:path";
import fs from "node:fs/promises";
import Docker from "dockerode";
import type { AgentId, DockerMemoryStats } from "../shared/types.js";
import type { SessionInfo } from "../shared/types.js";
import { LogStore } from "./log-store.js";
import type { PrStatusPoller } from "./pr-status-poller.js";
import { ReleaseStatusPoller } from "./release-status-poller.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { ServiceManager } from "./service-manager.js";
import type { ResolvedEgressConfig } from "./egress-allowlist.js";
import type { AppCtx } from "./ws-handlers/types.js";
import type { AppDeps } from "./app-di.js";
import type { ManagerSet } from "./app-di.js";
import { buildAgentRuntime } from "./agents/index.js";
import { LimitsRegistry } from "./limits-registry.js";
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
  createDepCacheDirHelper,
  createWarmPool,
  runRepoMigration,
  scheduleStartupTasks,
} from "./app-lifecycle.js";
import { createOomCircuitBreaker } from "./oom-circuit-breaker.js";
import { MergeWatchManager } from "./merge-watch.js";
import { createSessionLoopDetector } from "./loop-detector.js";
import { createRepoPrefetcher, type RepoPrefetcher } from "./repo-prefetch.js";
import { pruneSessionVolumes } from "./disk-janitor.js";
import { isOverlayEnabled } from "./overlay-session.js";
import { publishDepDirOverlayBases, type DepDirPublishOutcome } from "./overlay-publish.js";
import type { ContainerSessionRunner } from "./container-session-runner.js";
import { ClaudeOAuthRefresher } from "./agents/claude/oauth-refresher.js";
import { CodexOAuthRefresher } from "./agents/codex/oauth-refresher.js";
import { repushAgentToken, repushProviderAccountToken } from "./session-credentials.js";
import { MarketplaceStore } from "./marketplace-store.js";
import type { UpdateMode } from "./services/updates.js";
import type { VersionInfo } from "../shared/types.js";

/**
 * Static, process-lifetime metadata captured at startup and surfaced to the
 * client (e.g. the uptime / version badge over the SSE `system_info` event).
 * Computed in `index.ts` (so `processStartedAt` is the true process start) and
 * threaded through here so the SSE endpoint and routes can read it off the
 * runtime context.
 */
export interface BootstrapMeta {
  /** `Date.now()` captured once at process startup (live uptime badge). */
  processStartedAt: number;
  /** Build identifier of the running instance (baked `SHIPIT_BUILD_ID`). */
  buildId: string | undefined;
  /** Channel-aware human-facing version of the running instance (feature 162). */
  version: VersionInfo;
  /** Update mode (managed vs manual). */
  updateMode: UpdateMode;
  /** Resolved `dist/client` directory used by the static file handler. */
  clientDir: string;
}

/** Inputs to {@link bootstrapManagers}. */
export interface BootstrapManagersDeps {
  deps: AppDeps;
  mgrs: ManagerSet;
  /**
   * docs/172 (SHI-90) egress containment resolver. Computed in `index.ts`
   * (before the Fastify app + this call, to preserve the original ordering of
   * the UID guard) and fed straight into the container manager setup here.
   */
  resolveEgressConfig: (sessionId: string) => ResolvedEgressConfig;
  meta: BootstrapMeta;
}

/**
 * Instantiate and wire every orchestrator manager / collaborator, in the exact
 * order the original `buildApp()` did. This is pure DI + wiring — it does NOT
 * touch the Fastify `app` (no route registration; the first `app.X` call lives
 * in `route-registry.ts`) and starts no timers (those live in
 * `startup-monitors.ts`).
 *
 * The wiring order here is load-bearing — see CLAUDE.md §"Post-turn flow" and
 * the WebSocket-lifecycle invariants. Extracted from `index.ts` for the P4
 * split (docs/201) with no behavior change.
 *
 * Returns the full runtime context consumed by the SSE endpoint, the startup
 * monitors, and the route registry. The shape is inferred and re-exported as
 * {@link OrchestratorRuntime}.
 */
export async function bootstrapManagers(args: BootstrapManagersDeps) {
  const { deps, mgrs, resolveEgressConfig, meta } = args;
  const {
    defaultAgentId, workspaceDir, stateDir, credentialsDir, shouldServeStatic,
    autoPushDebounceMs, sessionsRoot, agentFactory,
    createGitManager, createRepoGit, databaseManager, sessionManager,
    repoStore, chatHistoryManager, usageManager, authManager, codexAuthManager,
    credentialStore, providerAccountManager, agentRegistry, githubAuthManager,
    secretStore, reviewStore, egressAllowlistStore, presentStore, generateText,
    isTestMode, runtimeMode,
  } = mgrs;

  // ---- Container manager (Docker isolation) ----
  const { containerManager, dockerProxyServer } = await setupContainerManager({
    deps, isTestMode, credentialsDir, stateDir, sessionManager, runtimeMode, resolveEgressConfig,
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
  // App-wide catalog list (Settings → Skills → Discover). v1 ships with
  // pre-seeded official Claude and Codex catalogs and never inserts/deletes
  // after that — v2 adds the add/remove verbs. The background pre-clone is
  // kicked off below, after the route table is registered.
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

  // ---- SSE (Server-Sent Events) ----
  const { sseClients, sseBroadcast } = createSSE();

  // ---- Log buffer ----
  // Durable per-session log store (docs/192) — backs both the agent "Logs" tab
  // and the preview-service log panels so history survives orchestrator
  // restart, idle eviction, and container destruction. The in-memory ring in
  // createLogBuffer stays as a hot, synchronous cache for diagnostics.
  const logStore = new LogStore(sessionsRoot);
  const { getLogBuffer, clearLogBuffer, removeLogBuffer, broadcastLog } = createLogBuffer(logStore);
  // docs/192 — drop a session's durable logs dir + in-memory ring when it goes
  // away for good (archive / delete / full reset). The disk-janitor sweep is
  // the startup backstop for paths that don't call this.
  const removeSessionLogs = (sid: string): void => {
    logStore.remove(sid);
    removeLogBuffer(sid);
  };

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
  const effectiveRunnerFactory = buildRunnerFactory({ deps, containerManager, credentialsDir, sessionManager, runtimeMode, broadcastLog, oomBreaker, presentStore });

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

  // docs/183 Phase 4b — runner-adapting publish-after-install hook. Closes over
  // the orchestrator-visible `stateDir` (same dir the disk-janitor sweeps) plus
  // the bare-cache git oracle, so `publishDepDirOverlayBases` stays runner- and
  // HTTP-agnostic. Cheap flag gate first so a kill-switched session never awaits
  // worker readiness. Default ON; inert when `OVERLAY_DEP_STORE=0`/`false`.
  const publishOverlayBases = async ({ runner, session, installOk, installCommands }: {
    runner: ContainerSessionRunner;
    session: SessionInfo;
    installOk: boolean;
    installCommands?: string[];
  }): Promise<DepDirPublishOutcome[]> => {
    if (!isOverlayEnabled() || !session.remoteUrl) return [];
    await runner.whenWorkerReady();
    return publishDepDirOverlayBases(
      { session, workerUrl: runner.getWorkerUrl(), installOk, installCommands },
      { stateDir, createRepoGit, getBareCacheDir },
    );
  };

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
    publishOverlayBases,
    logStore,
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

  // ---- Notify-on-merge watches (docs/196) ----
  // Built before the poller so the poller's `onPrTerminalState` hook can fire it.
  // The PR-status lookup + startup reconcile are bound after the poller exists.
  const mergeWatchManager = new MergeWatchManager({
    sessionManager,
    runnerRegistry,
    chatHistoryManager,
    defaultAgentId,
    credentialsDir,
    credentialStore,
    providerAccountManager,
    containerManager,
  });

  // ---- PR Status Poller ----
  const prStatusPoller = createPrStatusPoller({
    deps, githubAuthManager, sessionManager, sseBroadcast,
    runnerRegistry, createRepoGit, createGitManager, getBareCacheDir,
    mergeWatchManager,
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

  // docs/196 — bind the merge-watch PR-status lookup to the poller, then
  // re-derive any watch whose child PR already reached a terminal state while
  // the orchestrator was down (loadPersisted, run inside createPrStatusPoller,
  // has already seeded the snapshots this reads). Best-effort, off the boot path.
  mergeWatchManager.setPrStatusLookup((id) => prStatusPoller.getStatus(id));
  void mergeWatchManager.reconcilePending().catch((err: unknown) => {
    console.error("[merge-watch] startup reconcile failed:", err);
  });

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
    refresher.on("account_unauthenticated", (accountId: string) => {
      markProviderAccountUnauthenticated({
        agentId: "claude",
        accountId,
        providerAccountManager,
        agentRegistry,
        sseBroadcast,
      });
    });
    // Recovery counterpart: when a revoked account's token rotates back to
    // healthy, un-stick the `auth_failed` row + agent_list so the model
    // selector stops showing a false "needs auth". See docs/195.
    refresher.on("account_reauthenticated", (accountId: string) => {
      markProviderAccountReauthenticated({
        agentId: "claude",
        accountId,
        providerAccountManager,
        agentRegistry,
        sseBroadcast,
      });
    });
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
    // Recovery counterpart (mirrors the Claude wiring above): a background
    // rotation that heals a `auth_failed` Codex row clears the selector's
    // stale "needs auth". `markProviderAccountReauthenticated` is a no-op when
    // the row is already `ready`. See docs/195.
    codexRefresher.on("account_reauthenticated", (accountId: string) => {
      markProviderAccountReauthenticated({
        agentId: "codex",
        accountId,
        providerAccountManager,
        agentRegistry,
        sseBroadcast,
      });
    });
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

  return {
    // ---- Static metadata (threaded from index.ts) ----
    ...meta,
    deps,
    // ---- Manager set (re-surfaced so consumers destructure off the runtime) ----
    defaultAgentId, workspaceDir, stateDir, credentialsDir, shouldServeStatic,
    autoPushDebounceMs, sessionsRoot, agentFactory,
    createGitManager, createRepoGit, databaseManager, sessionManager,
    repoStore, chatHistoryManager, usageManager, authManager, codexAuthManager,
    credentialStore, providerAccountManager, agentRegistry, githubAuthManager,
    secretStore, reviewStore, egressAllowlistStore, presentStore, generateText,
    isTestMode, runtimeMode,
    // ---- Wired collaborators ----
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
    dockerSecretsConfig, serviceEnvDir,
    prStatusPollerRef,
    claudeOAuthRefresherRef, codexOAuthRefresherRef,
    nudgeClaudeOAuthRefresh, nudgeCodexOAuthRefresh,
    agentAuthRequiredHooks, onAgentAuthRequired,
    ensureTokenFreshHooks, ensureAgentTokenFresh,
    readSystemPromptApp,
    agentRuntime, authManagers, limitsProviders, runParamsPreps,
    publishOverlayBases,
    runnerRegistry,
    repoPrefetcher,
    drainQueueForSession,
    mergeWatchManager,
    prStatusPoller,
    releaseStatusPoller,
    limitsRegistry,
    recordAgentRateLimits,
    createSessionDir,
    warmSessionForRepo, waitForWarmSession,
    migratedRepoUrls,
    startupTimer,
  };
}

/**
 * The full runtime context produced by {@link bootstrapManagers} and consumed
 * by the SSE endpoint, the startup monitors, and the route registry. Inferred
 * from the return value so the field list lives in one place.
 */
export type OrchestratorRuntime = Awaited<ReturnType<typeof bootstrapManagers>>;
