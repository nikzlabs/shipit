/**
 * HTTP API routes — barrel module.
 *
 * Delegates route registration to domain-specific modules while preserving
 * the original `registerApiRoutes()` signature for backwards compatibility.
 */

import type { LoginIntegrationId } from "../shared/catalogue/types.js";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { SessionManager } from "./sessions.js";
import type { RepoStore } from "./repo-store.js";
import type { GitManager } from "../shared/git.js";
import type { RepoGit } from "./repo-git.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { CredentialStore } from "./credential-store.js";
import type { AgentRegistry } from "../shared/agent-registry.js";
import type { AgentId, AgentProcess, LimitsRefreshResult } from "../shared/types.js";
import type { UsageManager } from "./usage.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { SessionContainerManager } from "./session-container.js";
import type { ChatHistoryManager } from "./chat-history.js";
import type { AuthManager } from "./agents/claude/auth-manager.js";
import type { CodexAuthManager } from "./agents/codex/auth-manager.js";
import type { AgentAuthManager } from "./agent-auth-manager.js";
import type { PrepareRunParamsFn } from "./agent-run-params-prep.js";
import type { PrStatusPoller } from "./pr-status-poller.js";
import type { ReleaseStatusPoller } from "./release-status-poller.js";
import type { MergeWatchManager } from "./merge-watch.js";
import type { DatabaseManager } from "../shared/database.js";
import type { ServiceManager } from "./service-manager.js";
import type { LogRingEntry } from "../shared/types.js";
import type { SessionOomCircuitBreaker } from "./oom-circuit-breaker.js";
import type { SessionLoopDetector } from "./loop-detector.js";
import type { RuntimeMode } from "../shared/types.js";
import type { ProviderAccountManager } from "./provider-account-manager.js";
import type { ModelRunner } from "./services/redaction.js";
import type { LogStoreReader } from "./services/host-session-logs.js";

import { ServiceError } from "./services/index.js";

import { registerContainerOriginGuard } from "./api-container-guard.js";
import { registerBootstrapRoutes } from "./api-routes-bootstrap.js";
import { registerContainerRoutes } from "./api-routes-container.js";
import { registerHostRoutes } from "./api-routes-host.js";
import { registerSourceRoutes } from "./api-routes-source.js";
import { registerHostSessionRoutes } from "./api-routes-host-sessions.js";
import { registerFileRoutes } from "./api-routes-files.js";
import { registerGitRoutes } from "./api-routes-git.js";
import { registerSessionCrudRoutes } from "./api-routes-session-crud.js";
import { registerSessionReposRoutes } from "./api-routes-session-repos.js";
import { registerSessionSpawnRoutes } from "./api-routes-session-spawn.js";
import { registerLazyBodyRoutes } from "./api-routes-lazy-bodies.js";
import { createClaimSessionService, type ClaimSessionService } from "./services/claim-session.js";
import { registerPreviewRoutes } from "./api-routes-preview.js";
import { registerGitHubRoutes } from "./api-routes-github.js";
import { registerSecretsRoutes } from "./api-routes-secrets.js";
import { registerMcpRoutes } from "./api-routes-mcp.js";
import { registerReviewRoutes } from "./api-routes-reviews.js";
import { registerUpdateRoutes } from "./api-routes-updates.js";
import { registerAgentRoutes } from "./api-routes-agent.js";
import { registerLimitsRoutes } from "./api-routes-limits.js";
import { registerMarketplaceRoutes } from "./api-routes-marketplace.js";
import { registerVoiceRoutes } from "./api-routes-voice.js";
import { registerBugReportRoutes } from "./api-routes-bug-report.js";
import { registerProposeActionsRoutes } from "./api-routes-propose-actions.js";
import { registerEgressRoutes } from "./api-routes-egress.js";
import { registerIssueRoutes } from "./api-routes-issues.js";
import { registerPluginRepoRoutes } from "./api-routes-plugin-repos.js";
import type { PluginRefreshResult } from "./services/plugin-refresh.js";
import type { PluginCliRequest, PluginCliResult } from "./plugin-cli-run.js";
import type { SecretStore } from "./secret-store.js";
import type { EgressAllowlistStore } from "./egress-allowlist-store.js";
import type { FileReviewStore } from "./review-store.js";
import type { PresentStore } from "./present-store.js";
import type { MarketplaceStore } from "./marketplace-store.js";
import type { GenerateText } from "./non-turn-model.js";

/**
 * Dependencies needed by API routes. A subset of AppDeps — only the
 * app-level managers, no per-connection state.
 */
export interface ApiDeps {
  sessionManager: SessionManager;
  repoStore: RepoStore;
  createGitManager: (dir: string) => GitManager;
  createRepoGit: (dir: string) => RepoGit;
  agentRegistry: AgentRegistry;
  githubAuthManager: GitHubAuthManager;
  credentialStore: CredentialStore;
  providerAccountManager: ProviderAccountManager;
  /**
   * docs/179 — proactively heal an agent's OAuth source token before AI session
   * naming shells out to the CLI against the source credentials. A no-op for a
   * healthy token. Optional — tests / local runtime omit it.
   */
  ensureAgentTokenFresh?: (agentId: AgentId, accountId?: string) => Promise<boolean>;
  defaultAgentId: AgentId;
  workspaceDir: string;
  /**
   * Directory for orchestrator-internal state (SQLite, repo cache, dep cache,
   * marketplace cache). Defaults to `workspaceDir` when omitted, matching the
   * shape used elsewhere in `app-di.ts`. In local-mode dogfooding this is
   * outside the visible workspace.
   */
  stateDir?: string;
  /**
   * Orchestrator runtime mode (feature 118). Forwarded into the bootstrap
   * payload so the client can surface local-mode UI. Defaults to
   * `"containerized"` when omitted.
   */
  runtimeMode?: RuntimeMode;
  /**
   * docs/138 — source-of-truth credentials root (e.g. `/credentials`). Used by
   * `fullReset` to drop all per-session credential subtrees. Omitted in
   * runtimes without container credentials (tests, local mode).
   */
  credentialsDir?: string;
  usageManager: UsageManager;
  runnerRegistry: SessionRunnerRegistry;
  /**
   * docs/262 req 12 — run a plugin-repository refresh and WAIT for it, for the
   * agent's `shipit plugin refresh`. A runtime that cannot refresh supplies
   * `undefined` and the route says so rather than pretending it worked.
   *
   * **The key is REQUIRED even though the value may be `undefined`**, and that
   * is the whole point (found by dogfooding, 2026-08-14). Both of these hooks
   * were declared optional here, produced by `bootstrapManagers`, and then
   * never forwarded by `route-registry.ts` — which type-checked, so the routes
   * answered `501 This runtime cannot refresh plugin repositories.` on EVERY
   * deployment, production included, while every co-located test passed because
   * each injects the hook directly. A required key makes the omission a build
   * error; `| undefined` keeps the honest "this runtime has none" answer.
   */
  refreshPluginReposForSession: ((
    sessionId: string,
    workspaceDir: string,
    repoName?: string,
    onSettled?: (id: string) => void,
  ) => Promise<PluginRefreshResult>) | undefined;
  /**
   * docs/262 req 17 — run one imported plugin's companion CLI in an invocation
   * container (`plugin-cli-run.ts`). `undefined` where there is no Docker
   * (local mode, tests), which is the honest answer rather than running the
   * command somewhere it must not run (plan §1b). Required key for the reason
   * spelled out on `refreshPluginReposForSession` above.
   */
  runPluginCommandForSession: ((
    sessionId: string,
    workspaceDir: string,
    request: PluginCliRequest,
  ) => Promise<PluginCliResult>) | undefined;
  /**
   * Drop a session's pending debounced auto-push (`services/auto-push-scheduler.ts`).
   * Only ever called after a synchronous push has replaced it — the agent's own
   * `gh pr create`. Optional so tests and local runtimes can omit it; a missing
   * hook leaves the debounce armed, which is the safe direction (a redundant
   * push, never a lost one).
   */
  cancelAutoPush?: (sessionId: string) => void;
  chatHistoryManager: ChatHistoryManager;
  authManager: AuthManager;
  codexAuthManager: CodexAuthManager;
  /**
   * docs/155 Phase 2 — per-agent auth manager map, threaded through here so
   * the WS `AppCtx` (built from `ApiDeps`) can dispatch `auth_required` to
   * the failing turn's backend instead of always restarting Claude OAuth.
   */
  authManagers: Map<LoginIntegrationId, AgentAuthManager>;
  /**
   * docs/155 Phase 3 — per-agent run-params prep hooks. Threaded through so
   * the WS path can inject the right backend-specific fields (Claude's
   * `settingsPath`/`autoCreatePr`) without branching on `agentId` at the
   * call site.
   */
  runParamsPreps: Map<AgentId, PrepareRunParamsFn>;
  broadcastLog: (sessionId: string, source: "stderr" | "stdout" | "server" | "preview" | "install", text: string) => void;
  sseBroadcast: (event: string, data: unknown) => void;
  /**
   * docs/161 — run an on-demand `/api/oauth/usage` refresh and rebroadcast over
   * SSE. Backs the header pill's refresh button. `routeId` scopes the fetch to
   * one subscription; omitting it fans out over every connected account, which
   * is right for the sign-in seed and wrong for a button press (each route is a
   * separate upstream call against a tight budget). Resolves with one outcome
   * per attempted route. Omitted in test mode (no `LimitsRegistry`); the route
   * then 503s.
   */
  refreshSubscriptionLimits?: (
    /** docs/252 req 10 — `${serviceId}:${billingMode}`, the key quota is reported under. */
    modeKey: string,
    reason: "manual" | "seed",
    routeId?: string,
  ) => Promise<LimitsRefreshResult[]>;
  /**
   * docs/144 — push a sub-agent consult's carried-back rate-limit snapshot into
   * the matching `LimitsProvider`. Same closure the WS turn path uses; threaded
   * here so the sub-agent spawn route can keep the limit pill fresh. Omitted in
   * test mode (no `LimitsRegistry`).
   */
  recordAgentRateLimits?: (
    agentId: AgentId,
    session: { usedPct: number | null; resetAt: string } | null,
    weekly: { usedPct: number | null; resetAt: string } | null,
    sessionId?: string,
    /**
     * docs/252 req 10 — the credential route the reporting turn ACTUALLY ran
     * on, when the caller resolved one of its own. A consult routes
     * independently of the session's pin, and the snapshot is filed against
     * whatever `(service, mode)` owns the route.
     */
    routeId?: string,
  ) => void;
  /**
   * docs/164 — override for the bug-report Stage-2 (LLM) redaction pass. When
   * set, the bug-report route uses it instead of shelling out to the session's
   * agent CLI. Wired to a no-op (returns `null` → degrade to the Stage-1 floor)
   * in test mode so integration tests don't invoke a real CLI; omitted in
   * production so the route derives the per-session CLI runner.
   */
  bugReportModelRunner?: ModelRunner;
  getSharedRepoDir: (repoUrl: string) => string;
  createSessionDir: (title: string) => Promise<{ appSessionId: string; sessionDir: string; workspaceDir: string }>;
  // Phase 3 additions
  generateText: GenerateText;
  sessionsRoot: string;
  /** Warm a session for a repo (called after clone, after graduation, etc.). */
  warmSessionForRepo?: (repoUrl: string) => Promise<void>;
  /** Returns the in-flight warming promise for a repo, if any. */
  waitForWarmSession?: (repoUrl: string) => Promise<void> | undefined;
  /**
   * docs/145 — true when the repo's bare cache was pre-fetched in the
   * background recently enough that the claim path can skip its synchronous
   * `git fetch` to GitHub (the ~650ms that dominated claim latency). When
   * omitted (test mode, pre-fetch disabled) the claim always does the
   * synchronous fetch — the correct, slower fallback. Wired to
   * `RepoPrefetcher.coveredRecently`.
   */
  shouldSkipClaimFetch?: (repoUrl: string) => boolean;
  /** Create session dir (same as createSessionDir — alias for claim-session). */
  createSessionDirFull: (title: string) => Promise<{ appSessionId: string; sessionDir: string; workspaceDir: string }>;
  /** Container manager — needed for standby cleanup on repo delete. */
  containerManager?: SessionContainerManager;
  /** PR status poller — needed for tracking new PRs. */
  prStatusPoller?: PrStatusPoller;
  /** docs/214 — release lifecycle poller; the release routes drive it directly. */
  releaseStatusPoller?: ReleaseStatusPoller;
  /** docs/196 — notify-on-merge deliverer; the register route fires its register-time terminal-state check. */
  mergeWatchManager?: MergeWatchManager;
  /** Database manager — needed for full reset to clear all tables atomically. */
  databaseManager?: DatabaseManager;
  /** Secret store — per-repo env var secrets for preview containers. */
  secretStore?: SecretStore;
  /**
   * docs/172 (planning#92) — durable egress allowlist + containment toggle store.
   * Backs the browser-only egress Settings routes. Omitted in test setups that
   * don't exercise egress settings.
   */
  egressAllowlistStore?: EgressAllowlistStore;
  /**
   * docs/172 (planning#92) — whether this deployment can actually ENFORCE egress
   * containment (enforcement enabled AND the sidecar image configured). Surfaced
   * to the browser so the Settings → Network egress panel distinguishes
   * containment *policy* from *enforcement*. Defaults to false when omitted (test
   * setups / deployments without egress wiring).
   */
  egressEnforcementActive?: boolean;
  /** File review store — unified review surface persistence (per session/file). */
  reviewStore?: FileReviewStore;
  /**
   * docs/093 — durable Present-tab metadata store. Backs the `presentations`
   * field in the `/history` payload so the Present tab rehydrates on session
   * load (in addition to the WS `present_state` replay). Omitted in test setups
   * that don't exercise the Present tab.
   */
  presentStore?: PresentStore;
  /**
   * Marketplace store (docs/149 — skill install UX). When present, the
   * Settings → Skills tab + install/uninstall routes are wired. Test setups
   * that don't seed any marketplaces can omit this and the routes go away.
   */
  marketplaceStore?: MarketplaceStore;
  /**
   * Shared claim-session service (docs/149 v1c). Constructed once in
   * `registerApiRoutes` and threaded to every route module that mints a
   * repo-backed session (the home-screen claim, agent spawn, and the
   * skill-install-as-session route). A single instance is REQUIRED: the
   * per-repo serialization lives in the factory closure, so separate
   * instances would not guard concurrent git ops on the same bare cache.
   */
  claimSessionService?: ClaimSessionService;
  /** Service managers — per-session compose lifecycle (keyed by sessionId). */
  serviceManagers?: Map<string, ServiceManager>;
  /**
   * In-flight `mgr.stop()` promises keyed by sessionId. Used by `fullReset`
   * to await per-session compose-downs before wiping the workspace dir,
   * so we don't race the docker tool that's still tearing volumes down.
   */
  composeStopPromises?: Map<string, Promise<void>>;
  /**
   * Fallback volume prune for `archiveSession` when no runner is in the
   * registry (so `removeVolumesOnDispose` can't fire). Shells out to
   * `docker volume prune` filtered by `shipit-session=<id>`. Omitted in
   * test mode so tests don't touch the host Docker daemon.
   */
  pruneSessionVolumes?: (sessionId: string) => Promise<void>;
  /**
   * Read the per-session orchestrator log ring. Used by the diagnostics
   * endpoint to include the most recent log entries in the bug-report
   * payload. Optional — test setups may omit it (the endpoint then
   * returns an empty `recentLogs` array).
   */
  getLogBuffer?: (sessionId: string) => LogRingEntry[];
  /**
   * docs/192 — remove a session's durable `logs/` dir + in-memory ring when it
   * is archived/deleted. Optional; the disk-janitor sweep is the backstop.
   */
  removeSessionLogs?: (sessionId: string) => void;
  /**
   * docs/192 durable per-session log store. Read by the docs/264 Ops route,
   * which needs the on-disk backlog rather than the in-memory ring so a session
   * whose container is already gone still answers. Optional — a test harness
   * that omits it gets a 503 from that route rather than a misleading empty page.
   */
  logStore?: LogStoreReader;
  /**
   * OOM circuit breaker — passed into recovery service handlers so
   * user-initiated restarts reset the trip, and into the diagnostics
   * service so the panel can render the current breaker state.
   */
  oomBreaker?: SessionOomCircuitBreaker;
  /**
   * SIGTERM/recreate loop detector — passed into recovery service handlers
   * so a user-initiated restart clears the per-session event window. The
   * loop detector and the OOM breaker both gate the runner factory;
   * resetting one without the other leaves the restart blocked.
   */
  loopDetector?: SessionLoopDetector;
  /**
   * Optional fallback agent factory. Container runners create their own agents
   * via `runner.createAgent()`; this is only used when the runner has no
   * factory of its own (in-process tests).
   */
  agentFactory?: (agentId: AgentId) => AgentProcess;
  /**
   * Override the `fetch` used by MCP OAuth code-exchange / refresh
   * (docs/088 Phase 2). Tests inject a fake; production leaves this
   * undefined and the OAuth service uses the global `fetch`.
   */
  mcpOAuthFetchImpl?: typeof fetch;
  /**
   * docs/170 — override for the `fetch` used to reach issue trackers (Linear
   * GraphQL). Integration tests inject a stub; production leaves it undefined
   * and the tracker adapters use the global `fetch`.
   */
  trackerFetchImpl?: typeof fetch;
}

/**
 * Resolve a session ID to its workspace directory. Returns the session dir
 * or sends a 404 error and returns null.
 */
export function resolveSessionDir(
  sessionManager: SessionManager,
  sessionId: string,
  reply: FastifyReply,
): string | null {
  const session = sessionManager.get(sessionId);
  if (!session) {
    reply.code(404).send({ error: "Session not found" });
    return null;
  }
  if (!session.workspaceDir) {
    reply.code(404).send({ error: "Session has no workspace directory" });
    return null;
  }
  return session.workspaceDir;
}

/**
 * Register all HTTP API routes on the Fastify instance.
 * Called from buildApp() after managers are initialized.
 */
export async function registerApiRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  // ---- Error handler for ServiceError ----
  app.addHook("onError", (_request: FastifyRequest, reply: FastifyReply, error: Error, done: () => void) => {
    if (error instanceof ServiceError) {
      reply.code(error.statusCode).send({ error: error.message });
    }
    done();
  });

  // ---- Container ↔ browser trust boundary (docs/201 / planning#131) ----
  // Registered before the domain route modules so its `onRoute` hook observes
  // their `containerAccessible` opt-ins and its `onRequest` hook gates them.
  registerContainerOriginGuard(app, { containerManager: deps.containerManager });

  // Single shared claim-session service for every surface that mints a
  // repo-backed session (home-screen claim, agent spawn, skill-install-as-
  // session). The per-repo promise chain lives in the factory closure, so all
  // callers MUST share this instance for the serialization to guard the bare
  // cache. See ApiDeps.claimSessionService.
  const claimSessionService = deps.claimSessionService ?? createClaimSessionService({
    sessionManager: deps.sessionManager,
    repoStore: deps.repoStore,
    createGitManager: deps.createGitManager,
    createRepoGit: deps.createRepoGit,
    githubAuthManager: deps.githubAuthManager,
    getSharedRepoDir: deps.getSharedRepoDir,
    createSessionDirFull: deps.createSessionDirFull,
    sseBroadcast: deps.sseBroadcast,
    ...(deps.warmSessionForRepo ? { warmSessionForRepo: deps.warmSessionForRepo } : {}),
    ...(deps.waitForWarmSession ? { waitForWarmSession: deps.waitForWarmSession } : {}),
    ...(deps.shouldSkipClaimFetch ? { shouldSkipClaimFetch: deps.shouldSkipClaimFetch } : {}),
    ...(deps.containerManager ? { containerManager: deps.containerManager } : {}),
  });
  const deps2: ApiDeps = { ...deps, claimSessionService };

  // Register all domain-specific route modules
  await registerBootstrapRoutes(app, deps2);
  await registerFileRoutes(app, deps2);
  await registerGitRoutes(app, deps2);
  await registerSessionCrudRoutes(app, deps2);
  await registerSessionReposRoutes(app, deps2);
  await registerSessionSpawnRoutes(app, deps2);
  registerLazyBodyRoutes(app, deps2);
  await registerContainerRoutes(app, deps);
  await registerHostRoutes(app, deps);
  await registerSourceRoutes(app, deps);
  await registerHostSessionRoutes(app, deps);
  await registerPreviewRoutes(app, deps);
  await registerGitHubRoutes(app, deps);
  if (deps.reviewStore) {
    await registerReviewRoutes(app, deps);
  }
  if (deps.secretStore) {
    // serviceManagers is always available in production; we default to an
    // empty Map so test setups without compose can still mount the route.
    const serviceManagers: Map<string, ServiceManager> =
      deps.serviceManagers ?? new Map<string, ServiceManager>();
    await registerSecretsRoutes(app, {
      secretStore: deps.secretStore,
      sessionManager: deps.sessionManager,
      serviceManagers,
    });
  }
  await registerUpdateRoutes(app);
  await registerAgentRoutes(app, deps);
  await registerVoiceRoutes(app, deps);
  await registerBugReportRoutes(app, deps);
  await registerProposeActionsRoutes(app, deps);
  await registerEgressRoutes(app, deps);
  await registerIssueRoutes(app, deps);
  await registerPluginRepoRoutes(app, deps);
  await registerLimitsRoutes(app, deps);

  // Marketplace catalogs (docs/149). Wired only when a store is provided so
  // test setups that don't need this surface keep their route table minimal.
  if (deps.marketplaceStore) {
    await registerMarketplaceRoutes(app, {
      ...deps2,
      marketplaceStore: deps.marketplaceStore,
      stateDir: deps.stateDir ?? deps.workspaceDir,
    });
  }

  // MCP server CRUD + connectivity test (docs/088-mcp-integration).
  await registerMcpRoutes(app, {
    credentialStore: deps.credentialStore,
    runnerRegistry: deps.runnerRegistry,
    serviceManagers: deps.serviceManagers ?? new Map<string, ServiceManager>(),
    ...(deps.mcpOAuthFetchImpl !== undefined
      ? { oauthFetchImpl: deps.mcpOAuthFetchImpl }
      : {}),
  });
}
