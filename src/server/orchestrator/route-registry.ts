import type { FastifyInstance } from "fastify";
import { nativeServiceForHarness, selectionExists, selectionHonoursEffort } from "../shared/catalogue/index.js";
import { applyModelRetirement } from "./model-retirement.js";
import { buildAgentRerouteNotice } from "./agent-reroute-notice.js";
import {
  conformSelectionToAgent,
  describeSelectionMove,
  modelSelectionFrom,
  selectionFrom,
  verifyExplicitSelection,
} from "./model-switch.js";
import type { BillingMode, ModelSelection } from "../shared/catalogue/index.js";
import type { AgentId } from "../shared/types.js";
import type { WsClientMessage, WsServerMessage, WsLogRecord, LogSource } from "../shared/types.js";
import { agentLogAppend } from "./log-emit.js";
import { getErrorMessage } from "./validation.js";
import { getGitIdentity } from "./git-config.js";
import { readGlobalSystemPrompt } from "./global-system-prompt.js";
import { notableFilesForBranch } from "./services/notable-files.js";
import { emitResetEligible } from "./services/pre-turn-reset.js";
import { AgentTurnAdmissionError, type SessionRunnerInterface } from "./session-runner.js";
import { registerPreviewProxy } from "./preview-proxy.js";
import {
  corsHeadersFor,
  isWebSocketOriginAllowed,
  markPreviewProxyRegistered,
  readOriginPolicyFromEnv,
} from "./api-origin-guard.js";
import { frameGuardHeaders, framePolicyFromEnv } from "../shared/frame-policy.js";
import { projectTurnSnapshotForWire } from "./transcript-projection.js";
import type { ConnectionCtx, RunnerCtx, AppCtx } from "./ws-handlers/types.js";
import * as terminalHandlers from "./ws-handlers/terminal-handlers.js";
import * as miscHandlers from "./ws-handlers/misc-handlers.js";
import * as rollbackHandlers from "./ws-handlers/rollback-handlers.js";
import * as sendMessageHandlers from "./ws-handlers/send-message.js";
import * as bugReportHandlers from "./ws-handlers/bug-report-handlers.js";
import * as egressHandlers from "./ws-handlers/egress-handlers.js";
import { egressEnforcementActive, egressEnforcementStatus } from "./egress-firewall-install.js";
import { reconcileSessionEgress } from "./services/reconcile-session-egress.js";
import { egressDnsEnabled } from "./egress-dns-install.js";
import * as permissionHandlers from "./ws-handlers/permission-handlers.js";
import * as issueWriteHandlers from "./ws-handlers/issue-write-handlers.js";
import * as serviceHandlers from "./ws-handlers/service-handlers.js";
import { registerApiRoutes } from "./api-routes.js";
import { buildTurnMessages } from "./chat-card-persistence.js";
import type { GitManager } from "../shared/git.js";
import { readDockerMemoryStats } from "./docker-memory.js";
import { pruneSessionVolumes } from "./disk-janitor.js";
import { ensureCatalogCloned, getCatalogCacheRoot } from "./services/marketplace.js";
import { finishRestore, materializeRunnerSync } from "./services/materialize-runner.js";
import { buildAgentListPayload } from "./services/settings.js";
import { serveStaticClient } from "./app-assembly.js";
import type { OrchestratorRuntime } from "./bootstrap-managers.js";
import type { StartupMonitors } from "./startup-monitors.js";
import { getContainerFreshness } from "./container-freshness.js";
import { buildComposeAttachReplay } from "./compose-attach-replay.js";
import { startSseKeepalive, startWebSocketKeepalive } from "./keepalive.js";
import { applyRoleToSession, resolveUserRole } from "./services/session-role.js";
import { ServiceError } from "./services/types.js";

/**
 * Register the long-lived `/api/events` SSE endpoint. Kept as its own step so
 * it can run in its original position — after manager wiring but before the
 * startup monitors — preserving the exact `buildApp()` ordering.
 *
 * Extracted from `index.ts` for the P4 split (docs/201) with no behavior
 * change.
 */
export function registerSseEndpoint(app: FastifyInstance, rt: OrchestratorRuntime): void {
  const {
    sseClients, sessionManager, runnerRegistry, prStatusPoller,
    githubAuthManager, repoStore, agentRegistry, providerAccountManager, authManagers,
    credentialStore,
    dockerForStats, limitsRegistry,
    processStartedAt, buildId, version, updateMode,
  } = rt;
  const originPolicy = readOriginPolicyFromEnv();

  // SSE endpoint — long-lived HTTP response with text/event-stream
  app.get("/api/events", (request, reply) => {
    const headers: Record<string, string> = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // planning#370 — the allowlist, not a reflection of whatever arrived. This
      // route writes its headers onto the RAW response, so the origin hook's
      // work on `reply` never reaches the wire; it has to apply the same policy
      // itself. (The hook still decides whether the request gets this far.)
      ...corsHeadersFor(request.headers.origin, request.headers, originPolicy),
      // planning#379 — same story for the anti-framing headers: `frame-guard.ts`
      // sets them on `reply`, which this route never sends. An SSE stream is not
      // framable UI, so this is contract rather than exposure — but "every
      // response the orchestrator owns" has to be literally true, or the next
      // raw-response route inherits an untested exception.
      ...frameGuardHeaders(framePolicyFromEnv()),
    };
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
    // docs/193 (Thread C) — sessions blocked awaiting a permission answer, so
    // the sidebar "needs your approval" attention signal is correct on first
    // paint and survives a reconnect (the worker keeps holding the request).
    const awaitingPermissionSessions: string[] = [];
    // docs/235 — sessions holding outstanding background tasks. Snapshotted for
    // the same reason as the permission set: the client cannot re-derive it
    // after a reconnect (the backend reports the task list only on change, and
    // a reload misses every prior event), so without this a page refresh during
    // a long background task would show a session that looks finished.
    const backgroundTaskSessions: string[] = [];
    // docs/285 — the runner generation each session is on. A viewer holding an
    // older value is attached to a runner that has since been replaced (a
    // network-mode rebuild, a Rescue) and is receiving nothing; it reconnects
    // itself on seeing this. Snapshotted for EVERY session, not only the running
    // ones, because a viewer stranded on a dead runner is precisely one the
    // server does not see as running.
    //
    // Built from `listAll()` rather than the sidebar list above, which excludes
    // WARM sessions — and a warm session is exactly what a network-mode rebuild
    // replaces, so the one set this needs to cover was the one set it omitted.
    const runnerIncarnations: Record<string, number> = {};
    for (const session of sessionManager.listAll()) {
      const incarnation = runnerRegistry.incarnation(session.id);
      if (incarnation > 0) runnerIncarnations[session.id] = incarnation;
    }
    for (const session of sessions) {
      const runner = runnerRegistry.get(session.id);
      if (runner?.running) activeRunnerSessions.push(session.id);
      if (runner && runner.awaitingPermissionIds.size > 0) awaitingPermissionSessions.push(session.id);
      // planning#246 — the UNION (`backgroundWorkDescriptions`), not the
      // CLI-reported task list alone: a brokered `shipit agent run` consult
      // needs no resident streaming process and Codex reports no background
      // tasks at all, so a session waiting on a live review would otherwise be
      // snapshotted as idle.
      if (runner && runner.backgroundWorkDescriptions.length > 0) backgroundTaskSessions.push(session.id);
    }
    client.write(`event: active_runners\ndata: ${JSON.stringify({ sessionIds: activeRunnerSessions, runnerIncarnations })}\n\n`);
    client.write(`event: session_attention\ndata: ${JSON.stringify({ awaitingPermissionSessionIds: awaitingPermissionSessions, backgroundTaskSessionIds: backgroundTaskSessions })}\n\n`);

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

    // docs/171 — the release lifecycle card is now a persisted transcript card
    // (rehydrated from chat history on load, updated live via the `release_card`
    // WS), so there is no longer a `release_status` SSE snapshot to send here.

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

    // Use the canonical `buildAgentListPayload()` serializer (the same one
    // every `agent_list` *broadcast* uses) rather than hand-rolling it here.
    // A drifted inline copy previously omitted `reasoning`, so the connect/
    // reconnect snapshot shipped a reasoning-less list that clobbered the good
    // one in the store — the composer's reasoning control would vanish on SSE
    // reconnect (e.g. session switch / tab refocus) and only reappear once an
    // auth-event broadcast happened to re-send the full list. (docs/217)
    // docs/257 — and the same argument applies to `canRunTurns`, which is why
    // this snapshot builds the payload with `buildAgentListPayload` rather than
    // wrapping `listAgents` by hand: a reconnecting tab would otherwise clobber
    // a good value with `undefined`.
    client.write(`event: agent_list\ndata: ${JSON.stringify(buildAgentListPayload(agentRegistry, credentialStore, providerAccountManager))}\n\n`);
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
    //
    // The replay must carry `accountId` for the same reason the live broadcast
    // does (app-lifecycle.ts): the client files a challenge under the account
    // row that started it (docs/150-multiple-provider-subscriptions req 16), and there is no provider-wide slot
    // to fall back to. Omitting it here — as this did before — meant a reload
    // mid-sign-in replayed a challenge the UI had nowhere to put.
    for (const [loginId, mgr] of authManagers) {
      const details = mgr.getPendingPayload();
      if (details) {
        const accountId = mgr.getActiveAccountId() ?? undefined;
        client.write(`event: agent_auth_pending\ndata: ${JSON.stringify({ loginId, ...(accountId ? { accountId } : {}), details })}\n\n`);
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

    // Keep the stream non-idle so a reverse proxy (Cloudflare cuts at ~100s)
    // doesn't drop it during a quiet stretch with no session activity. See
    // `keepalive.ts`.
    const stopKeepalive = startSseKeepalive(client);

    request.raw.on("close", () => {
      client.closed = true;
      stopKeepalive();
      sseClients.delete(client);
    });
  });
}

/**
 * Register the orchestrator's HTTP API routes, marketplace pre-clone, preview
 * reverse proxy, test-only endpoints, static client serving, and the
 * per-session WebSocket route.
 *
 * Extracted from `index.ts` for the P4 split (docs/201) with no behavior
 * change. Consumes the wired runtime context plus `kickDiskEscalation` (created
 * by the startup monitors).
 */
export async function registerRoutes(
  app: FastifyInstance,
  rt: OrchestratorRuntime,
  monitors: StartupMonitors,
): Promise<void> {
  const {
    deps,
    defaultAgentId, workspaceDir, stateDir, credentialsDir, shouldServeStatic,
    autoPushScheduler, sessionsRoot, agentFactory,
    createGitManager, createRepoGit, databaseManager, sessionManager,
    repoStore, chatHistoryManager, usageManager, authManager, codexAuthManager,
    credentialStore, providerAccountManager, agentRegistry, githubAuthManager,
    secretStore, reviewStore, egressAllowlistStore, presentStore, generateText,
    isTestMode, runtimeMode,
    containerManager, getBareCacheDir, marketplaceStore, sseBroadcast,
    getLogBuffer, clearLogBuffer, broadcastLog, removeSessionLogs,
    oomBreaker, loopDetector,
    serviceManagers, composeStopPromises, composeWarnings, composeNotConfigured,
    nudgeClaudeOAuthRefresh, onAgentAuthRequired, ensureAgentTokenFresh,
    authManagers, runParamsPreps,
    runnerRegistry, repoPrefetcher, mergeWatchManager,
    refreshPluginReposForSession, runPluginCommandForSession,
    prStatusPoller, releaseStatusPoller, limitsRegistry, recordAgentRateLimits, markSessionAccountExhausted,
    createSessionDir, warmSessionForRepo, waitForWarmSession,
    clientDir, logStore, buildId,
  } = rt;
  const { kickDiskEscalation } = monitors;
  const wsOriginPolicy = readOriginPolicyFromEnv();

  // ---- HTTP API routes ----
  await registerApiRoutes(app, {
    sessionManager,
    cancelAutoPush: (sessionId: string) => autoPushScheduler.cancel(sessionId),
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
          refreshSubscriptionLimits: (modeKey: string, reason: "manual" | "seed", routeId?: string) =>
            limitsRegistry.refreshNow(modeKey, reason, routeId),
          // planning#339 — drop a removed credential's cached reading, so its
          // pill goes with it instead of outliving the credential it describes.
          forgetSubscriptionLimits: (modeKey: string, routeId: string) =>
            limitsRegistry.markSignedOut(modeKey, routeId),
          // docs/144 — let the sub-agent spawn route forward a consult's
          // rate-limit snapshot into the matching provider.
          recordAgentRateLimits,
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
    releaseStatusPoller,
    mergeWatchManager,
    databaseManager,
    secretStore,
    reviewStore,
    egressAllowlistStore,
    // docs/172 (planning#92) — honest enforcement signal for the browser: policy vs
    // actual enforcement. Fixed function of the process env.
    egressEnforcementActive: egressEnforcementActive(),
    // docs/285 — the same env read with the REASON kept. The boolean above
    // collapses "enforcement switched off" (session runs open) and "no sidecar
    // image" (session refuses to start) into one false, and the warning copy has
    // to tell the user which of those is about to happen to them.
    egressEnforcementStatus: egressEnforcementStatus(),
    // docs/285 req 3 — changing an ungraduated session's network mode rebuilds
    // its container, and the settings PUT awaits that. Assembled here because
    // this is where the recovery dependencies live; the route sees one call.
    reconcileSessionEgress: (sid: string, opts?: { agentSeed?: AgentId }) => reconcileSessionEgress(
      {
        containerManager: containerManager ?? null,
        egressAllowlistStore,
        ...(oomBreaker ? { oomBreaker } : {}),
        recovery: {
          sessionManager,
          containerManager: containerManager ?? null,
          runnerRegistry,
          defaultAgentId,
          ...(oomBreaker ? { oomBreaker } : {}),
          ...(loopDetector ? { loopDetector } : {}),
          // docs/285 — the rebuild replaces the runner, so every attached viewer
          // has to be told to reattach. This caller has no attachment of its own
          // to finish (it is an HTTP route), so `restartContainer` announces it
          // directly, exactly as Rescue does.
          sseBroadcast,
        },
      },
      sid,
      opts ?? {},
    ),
    // planning#383 — the other honest deployment signal: with Tier B off there
    // is no resolver to pin an allowed name's IPs and no proxy to permit its
    // SNI, so every host surface must stop offering grants that cannot work.
    egressDnsControlDeployed: egressDnsEnabled(),
    presentStore,
    serviceManagers,
    composeStopPromises,
    // docs/262 reqs 12, 17 — the agent's two plugin verbs. `bootstrapManagers`
    // has produced both since they landed; nothing forwarded them here, so both
    // routes answered 501 everywhere (found by dogfooding, 2026-08-14). The
    // ApiDeps keys are now required-but-nullable so a future omission is a
    // build error rather than a runtime "this runtime cannot…".
    refreshPluginReposForSession,
    runPluginCommandForSession,
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
    removeSessionLogs,
    // docs/264 — the Ops log-read route reads the DURABLE store, not the
    // in-memory ring, so it answers for a session whose container is gone.
    logStore,
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
    // planning#370 — from here on, a `{uuid}--{port}.…` Host is hijacked by the
    // proxy above and cannot reach an API route, so the origin guard steps
    // aside for it. Told to the guard at the registration site (rather than
    // read from a module flag) so a runtime WITHOUT the proxy — local mode —
    // keeps checking those hosts instead of being bypassed by a forged Host.
    markPreviewProxyRegistered(app);
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
    // periodic timer, and `createIdleEnforcer` acts only when over the memory
    // budget (docs/284).
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
          // The post-turn replay buffer. A terminal turn (result, error,
          // interrupt) must leave no AGENT CONTENT in it, so a reconnect can't
          // re-emit a completed turn (docs/163). The message types matter more
          // than the raw count: every terminal path legitimately emits a short
          // tail AFTER clearing the buffer (the trailing `session_status`, and
          // the post-turn `git_committed` when the turn's edits were committed),
          // so a count alone can't tell "harmless tail" from "the turn is still
          // in there".
          turnEventBufferSize: runner.getTurnEventBuffer().length,
          turnEventBufferTypes: runner.getTurnEventBuffer().map((m) => m.type),
        };
      },
    );

    // Test-only: ensure a runner exists and force its `running` flag. Lets
    // tests assert guards that depend on agent-in-progress state (e.g. the
    // merge endpoint's 409) without driving a full WS turn.
    //
    // `postTurnWork` drives the OTHER half of `agentBusy` (docs/266): the
    // terminal sequence and the debounced auto-push it arms, which run once
    // `running` is already false. A guard that must cover the whole window the
    // agent can still produce commits in has to be assertable there too.
    app.post<{ Params: { sessionId: string }; Body: { running?: unknown; postTurnWork?: unknown } }>(
      "/api/_test/runner/:sessionId/running",
      async (request, reply) => {
        const { sessionId } = request.params;
        const session = sessionManager.get(sessionId);
        if (!session?.workspaceDir) {
          reply.code(404);
          return { error: "Session not found or has no workspaceDir" };
        }
        const runner = runnerRegistry.getOrCreate(sessionId, session.workspaceDir, defaultAgentId);
        if (request.body?.running !== undefined) runner.running = request.body.running === true;
        if (request.body?.postTurnWork !== undefined) {
          const want = request.body.postTurnWork === true;
          if (want !== runner.postTurnWorkInFlight) {
            if (want) runner.beginPostTurnWork();
            else runner.endPostTurnWork();
          }
        }
        return {
          ok: true,
          running: runner.running,
          postTurnWorkInFlight: runner.postTurnWorkInFlight,
          agentBusy: runner.agentBusy,
        };
      },
    );
  }

  // Serve the built client files from dist/client/
  await serveStaticClient(app, clientDir, shouldServeStatic);

  // ---- Per-session WebSocket route ----
  // Session-scoped WS: auto-activates the session on connect, no activate_session needed.
  // The session ID is in the URL path. Agent preference via ?agent= query param.
  app.get<{ Params: { sessionId: string }; Querystring: { agent?: string; model?: string; reasoning?: string; service?: string; billingMode?: string; role?: string } }>(
    "/ws/sessions/:sessionId",
    { websocket: true },
    (socket, request) => {
      const { sessionId } = request.params;
      // planning#370 — CORS does not apply to WebSockets: the browser sends
      // `Origin` on the handshake and then does whatever the server allows, so
      // a CORS-only fix would leave the whole session channel open to any page
      // the user loads. A handshake with no `Origin` is a non-browser client
      // and passes.
      //
      // Today the global hook (`api-origin-guard.ts`) already refuses such an
      // upgrade with a 403 — `onRequest` hooks run for the upgrade request too
      // — so this is a backstop, not the only check. It is here because that is
      // a property of how @fastify/websocket routes upgrades, not of anything
      // this code states, and the cost of being wrong about it is the whole
      // session channel.
      if (!isWebSocketOriginAllowed(request.headers, wsOriginPolicy, {
        requestIsSecure: (request.headers["x-forwarded-proto"] ?? "").toString().startsWith("https"),
      })) {
        console.warn(`[ws] refused upgrade from origin ${String(request.headers.origin)}`);
        socket.close(4403, "Cross-origin connection refused");
        return;
      }
      const session = sessionManager.get(sessionId);
      if (!session) {
        socket.close(4004, "Session not found");
        return;
      }
      console.log(`[ws] session client connected: ${sessionId}`);

      // A session between turns sends nothing, and a reverse proxy in front of
      // ShipIt (Cloudflare cuts at ~100s) kills the socket for being idle. The
      // client then reconnects on backoff and re-runs the full attach burst,
      // which is the flicker-plus-log-churn failure this guards against. See
      // `keepalive.ts`.
      const stopKeepalive = startWebSocketKeepalive(socket, {
        onUnresponsive: () => {
          console.log(`[ws] session client unresponsive, terminating: ${sessionId}`);
        },
      });

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
      // planning#389 — set when the reconciliation below moves an unpinned session
      // off the harness the browser explicitly asked for. Delivered on the first
      // turn (see the persist block), never emitted from here, so it costs nothing
      // on the overwhelmingly common connect where nothing is rerouted.
      let agentRerouteNotice: string | undefined;
      // docs/252 phase 8 (req 13) — resolve a retired model to its successor
      // BEFORE anything else reads the row. Without this the self-heals below
      // see an id no harness lists and drop the session onto `models[0]`, which
      // is a model the user never chose and possibly a different price class;
      // the retirement record is what says where it should actually go. The
      // harness is the session's own when it has one, since the successor must
      // be one that harness can run.
      const sessionModel = applyModelRetirement(
        sessionManager,
        session,
        session.agentId ?? (request.query.agent as AgentId | undefined) ?? defaultAgentId,
      );
      if (session.agentPinned) {
        perConnectionAgentId = session.agentId ?? defaultAgentId;
        const agentInfo = agentRegistry.get(perConnectionAgentId);
        selectedModel = sessionModel ?? agentInfo?.capabilities.models[0];
        // Self-heal an incoherent legacy row whose model the pinned agent can't run.
        if (selectedModel && agentInfo && !agentInfo.capabilities.models.includes(selectedModel)) {
          selectedModel = agentInfo.capabilities.models[0];
        }
      } else {
        const requestedAgent = request.query.agent as AgentId | undefined;
        const requestedModel = request.query.model;
        perConnectionAgentId = session.agentId ?? requestedAgent ?? defaultAgentId;
        selectedModel = sessionModel ?? requestedModel;
        // Reconcile agent ↔ model for an as-yet-unpinned (warm) session. They
        // come from INDEPENDENT sources, so they can diverge — most often a
        // stale `agent=codex` riding in alongside the user's real `model=opus`
        // pick. The product rule (docs/142 C): the model is the user's only real
        // control, so the **model is authoritative** — derive the agent that
        // owns it. This is the server-side guard against the Opus→gpt-5.5 switch.
        //
        // …and it applies only where the two genuinely CONFLICT. docs/252 made a
        // harness pick a real control of its own for any model more than one
        // harness can speak, so "authoritative" cannot mean "the model re-decides
        // the harness every connect" any more; it means the model wins the cases
        // where the pair cannot both be honoured. See the membership guard below.
        const model = selectedModel;
        // docs/272-user-selectable-roles reqs 8, 13 — **a role's harness is never re-derived**,
        // and this is the one place that would have done it behind the user's
        // back. The derivation below answers "which harness owns this model" with
        // whichever the registry lists first, and docs/252 made that ambiguous:
        // a dual-harness model (DeepSeek V4) belongs to both. So a session
        // running the role `triage` on Codex would, on its next RECONNECT, be
        // moved to Claude and persisted there (the write two blocks down) while
        // the composer went on naming `triage` — the session running something
        // other than what the role says, with nothing on screen to tell.
        //
        // A role in force means the row is not two independent sources that need
        // reconciling: all three fields were written together, from one tuple the
        // user chose. Nothing to derive, so nothing is derived — which is
        // docs/264 req 6's rule reaching the one path that predates it.
        const roleDecidesHarness = !!session.roleName;
        // planning#389 / docs/252 — MEMBERSHIP, not the single "owner" the
        // registry-order lookup above answers with. That ambiguity is not only the
        // role's problem: `deepseek-v4-flash` carries three API styles, so ALL
        // three harnesses list it and the derived owner is always Claude Code. A
        // harness that was actually NAMED and can actually run the model is not
        // the stale-key case this guard is for — deriving there discarded the
        // user's own pick, persisted it two blocks down, and pinned it write-once
        // on the first turn while the composer went on displaying the harness they
        // chose (the client applies this same tie-break in `newSessionAgentId`, so
        // screen and session disagreed with nothing to tell). Reproduced
        // 2026-08-18: a session created on OpenCode with `deepseek-v4-flash` ran
        // its whole life on Claude Code.
        //
        // The candidates are the harnesses somebody actually NAMED, in the same
        // precedence `perConnectionAgentId` is built with above — the session's own
        // row first, the query param second — since both are choices and only
        // `defaultAgentId` is a fallback. Ordered rather than "the first one only",
        // because the row and the param disagree exactly when the user has just
        // moved the model: a session row still naming Claude Code, a browser asking
        // for OpenCode, and a model only OpenCode can run is a pick to honour, not
        // a pair to derive an unrelated third harness from.
        //
        // "Can run it" includes the install, exactly as `newSessionAgentId` has it:
        // a browser key outlives a deployment that dropped the harness, and
        // honouring one of those would pin a session whose first turn cannot start.
        //
        // The two sibling copies of this rule were already corrected — the client's
        // `newSessionAgentId` (docs/166) and `createHeadlessSession`'s
        // `explicitAgentRunsModel` (planning#304/#389). This connect handler was
        // the third and the one that never got the fix.
        const namedAgents = [session.agentId, requestedAgent].filter(
          (id): id is AgentId => !!id,
        );
        // Gated on the role too: under a role NOTHING is reconciled, so this must
        // not become a second way to move the harness. The role's own harness is
        // already `session.agentId`, so honouring it would be a no-op in the case
        // that matters — but a role whose model its harness cannot run would fall
        // through to the query param and move the session, which is precisely what
        // docs/272 reqs 8, 13 forbid.
        const honouredAgent = model && !roleDecidesHarness
          ? namedAgents.find((id) => {
              const info = agentRegistry.get(id);
              return info?.installed && info.capabilities.models.includes(model);
            })
          : undefined;
        const modelOwner = model && !roleDecidesHarness && !honouredAgent
          ? agentRegistry.list().find((a) => a.capabilities.models.includes(model))
          : undefined;
        if (honouredAgent) {
          perConnectionAgentId = honouredAgent;
        }
        if (modelOwner) {
          perConnectionAgentId = modelOwner.id;
          // planning#389 — what is left for the derivation is the case docs/142
          // Problem C is really about: a named harness that shares NO API style
          // with the model. Rerouting is still the answer here (a WS upgrade
          // cannot refuse with a 400 the way `createHeadlessSession` does without
          // taking the session's whole channel down, and the stale `vibe-agent-id`
          // it was written for is the majority of this input) — but it must not be
          // SILENT. planning#389 measured the cost of silence on the headless path:
          // a user asked for Codex, got Claude, and was billed $0.14 with
          // `pending_agent_notice` left NULL. So the reroute now leaves the
          // sentence for the first turn to deliver.
          //
          // Only when it contradicts a harness the BROWSER explicitly asked for.
          // A reroute that lands on the requested harness is the client's own rule
          // agreeing with the server's, which is the ordinary "user changed the
          // model, so the harness followed" path and has nothing to announce.
          if (model && requestedAgent && requestedAgent !== modelOwner.id) {
            agentRerouteNotice = buildAgentRerouteNotice(requestedAgent, modelOwner.id, model);
          }
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
        // planning#389 — gated on the same condition as the write, so the sentence
        // is recorded exactly when the persisted harness actually CHANGES. On the
        // next connect the session's own row names the new harness, which can run
        // the model, so nothing is derived and nothing is re-recorded: one notice
        // per reroute, not one per reconnect.
        //
        // APPENDS rather than sets — docs/221's slot is last-write-wins because
        // every writer described the same fact (where the branch now points), and
        // "your harness changed" is a different fact; overwriting a branch-movement
        // or LFS notice with it would lose one of the two.
        if (agentRerouteNotice) {
          try {
            sessionManager.appendPendingAgentNotice(sessionId, agentRerouteNotice);
          } catch { /* ignore */ }
        }
      }
      if (selectedModel && selectedModel !== sessionModel) {
        // docs/252 — persist the SELECTION. The browser's seed carries the
        // service and billing mode alongside `?model=` (its `vibe-model-id` slot
        // holds the full triple), and it is honoured only when it names a row
        // the catalogue actually contains AND the model being persisted is the
        // seeded one — a reconciled fallback model is a different choice and
        // must not inherit the seed's service. Otherwise resolution is biased
        // toward the harness's own vendor, which is the frozen fact for any
        // legacy id: before this feature a harness could reach nothing else.
        const seededMode: BillingMode | undefined =
          request.query.billingMode === "sub" || request.query.billingMode === "key"
            ? request.query.billingMode
            : undefined;
        const seeded: ModelSelection | undefined =
          request.query.service && seededMode && selectedModel === request.query.model
            ? {
                serviceId: request.query.service,
                billingMode: seededMode,
                modelId: selectedModel,
              }
            : undefined;
        try {
          // docs/252 phase 3 — the seed must be ELIGIBLE, not merely present in
          // the catalogue. The browser slot outlives a credential change, so a
          // triple written while a subscription was connected still names a real
          // row after it goes away; accepting it pins the session to a mode with
          // no credential and fails its first turn. Falling through to the
          // bare-id resolution lands on a mode that does have one. The client
          // drops such a seed too (`isSelectionEligibleForAgent`); this is the
          // server refusing to trust it either.
          const seedEligible =
            seeded
            && (agentRegistry.get(perConnectionAgentId)?.eligibleModels ?? []).some(
              (m) =>
                m.serviceId === seeded.serviceId
                && m.billingMode === seeded.billingMode
                && m.modelId === seeded.modelId,
            );
          if (seeded && selectionExists(seeded) && seedEligible) {
            sessionManager.setModelSelection(sessionId, seeded);
          } else {
            sessionManager.setModel(
              sessionId,
              selectedModel,
              nativeServiceForHarness(perConnectionAgentId),
            );
          }
        } catch { /* ignore */ }
      }
      // docs/217 — per-session reasoning effort (Control B). Prefer the persisted
      // row; for an as-yet-unpinned (new/warm) session with none, fall back to the
      // client's per-agent localStorage seed sent as `?reasoning=` — this mirrors
      // model seeding (`session.model ?? requestedModel`) so the composer's
      // displayed seed actually applies to the very first turn instead of silently
      // running with no flag. Dropped if invalid for the resolved agent.
      const requestedReasoning =
        !session.agentPinned && typeof request.query.reasoning === "string"
          ? request.query.reasoning
          : undefined;
      let selectedReasoning: string | undefined = session.reasoningEffort ?? requestedReasoning;
      {
        // docs/274 req 14 — asked of the SELECTION, not of the harness's raw
        // vocabulary. A harness can declare a level and honour none on a given
        // row (grok, key-billed), so a vocabulary check would rehydrate a
        // session with a level its every turn silently discards — and persist
        // it, since the branch below writes the reconciled value back.
        const reasoningSelection =
          session.serviceId && session.billingMode && session.model
            ? { serviceId: session.serviceId, billingMode: session.billingMode, modelId: session.model }
            : undefined;
        if (
          selectedReasoning
          && !selectionHonoursEffort(perConnectionAgentId, reasoningSelection, selectedReasoning)
        ) {
          selectedReasoning = undefined;
        }
        if (selectedReasoning !== (session.reasoningEffort ?? undefined)) {
          try { sessionManager.setReasoning(sessionId, selectedReasoning ?? null); } catch { /* ignore */ }
        }
      }
      // docs/272-user-selectable-roles reqs 3, 13 — **if the reconciliation above moved the
      // session off what the role set, the name stops being shown**, because it
      // has stopped being true.
      //
      // Everything above answers "what should this session run", and two of its
      // answers can move a session nobody touched: a **retired** model resolves
      // to its successor (`applyModelRetirement`), and a model the session's
      // harness no longer lists is replaced with that harness's first. Neither
      // goes through `set_model`, so neither reaches
      // `leaveRoleOnParameterChange` — and a role whose model has been swapped
      // out from under it would go on naming a session running something else,
      // which is the one screen state req 13 exists to rule out.
      //
      // Compared against `session`, the row as it was read at the top of this
      // handler, so this sees the whole of what the block decided rather than any
      // single write inside it.
      if (
        session.roleName
        && (perConnectionAgentId !== session.agentId
          || selectedModel !== session.model
          || (selectedReasoning ?? undefined) !== (session.reasoningEffort ?? undefined))
      ) {
        try { sessionManager.setRoleName(sessionId, null); } catch { /* ignore */ }
      }

      // docs/272-user-selectable-roles req 12 — the role the user last selected, seeding a
      // BRAND-NEW session exactly as `?agent=` / `?model=` / `?reasoning=` above
      // seed the three controls it replaces.
      //
      // **It overrides all three**, and that precedence is the whole point: a
      // role IS the harness, model and level, so the seeds reconciled just above
      // describe controls the user has handed over to it. Applying the role last
      // is what makes "the composer shows a role" and "the session runs the
      // role's parameters" the same fact on the very first turn.
      //
      // Guarded three ways, each of which is a case where the seed must NOT win:
      // a session that has taken its first turn (req 4 — nothing applies a role
      // after that), one that already carries a role (its own choice outranks a
      // browser slot), and one whose harness is pinned. A role that no longer
      // resolves — deleted, stranded, disconnected — is skipped in silence
      // rather than refused: this is a page load, not an action, and the user is
      // told by the composer showing today's ordinary controls instead of a name
      // that would be a lie (req 8: nothing is ever substituted).
      const requestedRole =
        typeof request.query.role === "string" && request.query.role.length > 0
          ? request.query.role
          : undefined;
      //
      // **The clear just above needs no guard of its own**: the seed outlives it,
      // so a later connect does reach here with the role's name — and
      // `resolveUserRole` refuses it, because the only two things that clear a
      // role there (a retired model, a model the harness no longer lists) are
      // both things that make the ROLE unrunnable too. A retired id lives in its
      // mode's `retired[]` and not in its model list, so `selectionExists` is
      // already false for it. Pinned by a test in `services/session-role.test.ts`,
      // since it is a property of the catalogue rather than of this block.
      //
      // **req 18's clear is the case that argument does not cover, and it needs
      // the fourth guard.** A role the USER cleared is perfectly runnable, so
      // nothing downstream would refuse it — and the browser's seed sits inside
      // a per-session memoized WebSocket URL, so a reconnect between the clear
      // and the first message arrives here still naming it. Without
      // `roleExplicitlyCleared` the clear would silently undo itself, standing
      // instructions and all. It reads the row directly because "chose none" and
      // "never chose" are one value in `SessionInfo` on purpose.
      //
      // **Applying it is only half — the viewer has to be TOLD.** The composer
      // reads a live session's role from the session row it already holds, and
      // that row was fetched before this connect wrote to it. On `/{repo}/new`
      // that never showed, because a warm session has no row and the composer
      // displays the seed there instead; but a surface that navigates the user
      // straight onto a FRESH session the browser has already listed — an ops
      // session (docs/128), a sandbox (docs/211), both of which refresh the list
      // and only then navigate — reads the stale copy and shows no role at all,
      // while the session quietly runs on it. So the seed's answer is emitted
      // below, next to `activateSession`, exactly as `set_role`'s is.
      let seededRoleApplied = false;
      if (
        requestedRole
        && !session.agentPinned
        && !session.roleName
        && !sessionManager.roleExplicitlyCleared(sessionId)
      ) {
        try {
          const seededRole = resolveUserRole(requestedRole, { credentialStore });
          applyRoleToSession(sessionId, seededRole, { sessionManager });
          perConnectionAgentId = seededRole.params.harnessId;
          selectedModel = seededRole.params.modelId;
          selectedReasoning = seededRole.params.reasoningEffort;
          seededRoleApplied = true;
        } catch {
          // Skipped, deliberately — see above.
        }
      }

      let attachedRunner: SessionRunnerInterface | null = null;
      let runnerMessageListener: ((msg: WsServerMessage) => void) | null = null;
      let previewRetryListener: ((msg: WsServerMessage) => void) | null = null;

      const send = (msg: WsServerMessage) => {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify(msg));
        }
      };

      const sendContainerFreshness = (sid: string) => {
        const container = containerManager?.get(sid);
        send({
          type: "session_container_freshness",
          sessionId: sid,
          freshness: getContainerFreshness(container?.workerBuildId, buildId),
        });
      };

      // planning#317 — rehydrate the "commits are blocked by a secret" banner. This is
      // the half that makes the warning genuinely sticky: the block lives in the
      // working tree, which outlives both the runner and the container, so a
      // reload or a session switch has to be able to re-derive it from the
      // session row rather than from a message that happened to be in flight.
      const sendSecretBlock = (sid: string) => {
        send({
          type: "secret_block_status",
          sessionId: sid,
          block: sessionManager.getSecretBlock(sid) ?? null,
        });
      };

      /**
       * docs/252 phase 4 (req 4) — confirm the session's authoritative selection
       * after a `set_model` / `set_agent`, with `notice` set only when the
       * server moved something the user did not pick.
       *
       * Read back from the session row rather than echoed from the request: the
       * row is what the next turn's spawn identity and usage attribution are
       * derived from, so echoing the request would let the composer show a
       * selection the turn will not use.
       *
       * Per-connection, like the sibling `error`: it is feedback on a control
       * THIS connection just operated. Deliberately not `runner.emitMessage` —
       * that buffers into the turn-event log, and replaying a stale selection to
       * a reconnecting viewer would clobber a newer one. Other viewers converge
       * on their next session-list refresh, unchanged from before.
       */
      const sendSelectionChanged = (agentId: AgentId, notice?: string): void => {
        const session = activeAppSessionId ? sessionManager.get(activeAppSessionId) : undefined;
        // No session row to report on — nothing was persisted, so there is no
        // authoritative selection to converge the picker onto. A notice still
        // has to reach the user rather than being swallowed, so it degrades to
        // the plain error path.
        if (!activeAppSessionId || !session) {
          if (notice) send({ type: "error", message: notice });
          return;
        }
        const selection = selectionFrom(session);
        send({
          type: "model_selection_changed",
          sessionId: activeAppSessionId,
          agentId,
          selection: selection ?? null,
          modelId: session.model ?? null,
          reasoningEffort: session.reasoningEffort ?? null,
          // docs/272 req 15 — read from the row rather than passed in, so the
          // one place that clears a role (the three handlers below) and the one
          // that sets it cannot disagree with what this reports.
          roleName: session.roleName ?? null,
          ...(notice ? { notice } : {}),
        });
      };

      /**
       * docs/272-user-selectable-roles req 15 — **changing a parameter is the whole of leaving a
       * role.**
       *
       * Called by `set_agent`, `set_model` and `set_reasoning`, because those
       * three are exactly the controls a role replaced. Nothing is confirmed,
       * warned about or put back: the session goes on running whatever the user
       * just chose, and only the *name* stops being shown — because it stopped
       * being true.
       *
       * Not called by `set_role` itself, which writes the same three fields:
       * that write is the role being applied, not the user leaving it.
       *
       * **A pick that changes nothing is not a change**, which is why this takes
       * a `before` snapshot rather than firing on every message. Re-selecting the
       * harness a role already named — easy to do, since "Adjust parameters…"
       * opens those very controls with the role's own values in them — would
       * otherwise un-name the role while leaving the session identical. The
       * snapshot is also what makes the refusal paths safe: those `return` before
       * reaching here, so a rejected `set_model` cannot cost the user their role.
       */
      const roleRelevantSnapshot = (): string => {
        const s = activeAppSessionId ? sessionManager.get(activeAppSessionId) : undefined;
        return [s?.agentId, s?.serviceId, s?.billingMode, s?.model, s?.reasoningEffort]
          .map((v) => v ?? "")
          .join("|");
      };
      const leaveRoleOnParameterChange = (before: string): void => {
        if (!activeAppSessionId) return;
        if (!sessionManager.get(activeAppSessionId)?.roleName) return;
        if (roleRelevantSnapshot() === before) return;
        try { sessionManager.setRoleName(activeAppSessionId, null); } catch { /* ignore */ }
      };

      const onContainerStarted = (sid: string) => {
        if (sid === activeAppSessionId) sendContainerFreshness(sid);
      };
      containerManager?.on("container_started", onContainerStarted);

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
        // The running turn's transcript, as of THIS instant. Built in the same
        // synchronous block that subscribed the socket above, so it covers
        // exactly everything up to the attach and every later event arrives
        // live on this socket — no gap, no overlap.
        //
        // This replaces reconstructing the turn from the `GET /history` DB
        // snapshot plus a cursor-sliced `agent_event` replay. Those are sampled
        // at two different times (the browser's history fetch is a round trip
        // that lands before or after this attach, depending on latency), and a
        // tool-result boundary landing between them either erased a slice of
        // the turn from the transcript or duplicated it — the "switch away
        // mid-turn and the earlier messages are gone" bug. The client applies
        // this by REPLACING its in-progress rows, so either order self-corrects.
        // See `WsTurnSnapshot`.
        if (runner.running) {
          send({
            type: "turn_snapshot",
            sessionId: runner.sessionId,
            // docs/244 req 6 — the byte bound applies to reconnects too. This
            // snapshot is built from the runner's in-memory groups, not read
            // through `getChatHistory`, so it is its own projection site;
            // without this a mid-turn reconnect re-sent every heavy body the
            // history path had just stripped.
            //
            // planning#299 — `committedBodyIds` says which half of the in-flight turn
            // a boundary has already written, so the already-committed prefix is
            // stripped too and only the genuinely in-memory tail ships whole.
            messages: projectTurnSnapshotForWire(
              runner.sessionId,
              buildTurnMessages(
                runner.chatMessageGroups,
                runner.steeredMessages,
                runner.recordedCards,
                { inProgress: true },
              ),
              runner.committedBodyIds,
            ),
          });
        }
        // Replay the part of the turn buffer that has not already been folded
        // into HTTP chat history — the non-transcript signals (compaction
        // status, usage, spawn chips, …) that the snapshot above doesn't
        // express.
        //
        // `agent_event` is deliberately skipped: the snapshot is now the
        // authoritative rebuild of the turn's messages, and replaying the same
        // events on top of it would double the assistant text and tool calls.
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
          if (buffered.type === "agent_event") continue;
          // A buffered snapshot belongs to the attach (or turn end) that
          // produced it. Replaying one against a viewer that has since loaded
          // history would append the turn a second time — its rows are no
          // longer marked in-progress there, so the replace-filter has nothing
          // to remove. This attach sent its own current snapshot above.
          if (buffered.type === "turn_snapshot") continue;
          // Agent log lines are re-seeded by the `log_snapshot` above, so skip
          // the buffered `log_append`s here to avoid duplicating the backlog.
          if (buffered.type === "log_append") continue;
          if (buffered.type === "terminal_output") continue;
          if (buffered.type === "terminal_exit") continue;
          if (buffered.type === "terminal_reconnecting") continue;
          // planning#246 — `background_tasks` is deliberately skipped: this attach's
          // own `GET /history` carries the runner's CURRENT `backgroundTasks`,
          // read live at request time, so the replay can only ever be older.
          // That mattered because the marker is also cleared by paths that emit
          // no `background_tasks` of their own (a crashed process, a disposed
          // runner — they announce over SSE instead), which leaves the last
          // buffered copy saying "outstanding" after the truth became "none".
          // Replaying it resurrected a green dot on a session with nothing
          // running, and whether it won came down to whether the replay landed
          // before or after the HTTP history it contradicts. Dropping it makes
          // history the single attach-time source, with no race to lose.
          if (buffered.type === "background_tasks") continue;
          // `system_user_message` is deliberately NOT skipped: it is the only
          // carrier of a dispatch's activity label ("Auto-fixing CI…"), which
          // neither history nor `session_status` restores. It is safe to replay
          // on top of this attach's own history because the user row and the
          // echo now share a `clientRequestId`, so the client reconciles them
          // whichever arrives second.
          send(buffered);
        }
        // UNCONDITIONAL, empty queue included: an empty snapshot is exactly the
        // correction a re-attaching viewer needs. The client clears
        // `queuedMessages` only on a live `queue_updated`, an interrupt, or a
        // switch to another session — a plain reconnect on the SAME session
        // clears nothing. So a queue that drained while nobody was attached left
        // the queued bubble on screen forever: the drain's live `queue_updated`
        // reached no one, and `resetRunnerTurnState` clears the turn-event
        // buffer when the drained turn starts, so the replay above can't carry
        // it either. Same reasoning as the `active_runners` SSE snapshot.
        send({ type: "queue_updated", queue: runner.getQueueSnapshot() });
        // Still conditional, deliberately: unlike the queue, neither half of a
        // stale running state can survive. The chat status line is corrected by
        // the re-attach itself — the client reloads HTTP history on every WS
        // open and sets `isLoading` from the authoritative `agentRunning`
        // there. The sidebar's `activeRunnerSessions` is corrected on a
        // different channel rather than by this attach: live SSE
        // `session_agent_finished` transitions, and the unconditional
        // `active_runners` snapshot that replaces the set wholesale on every
        // SSE (re)connect. Sending this unconditionally would add nothing.
        if (runner.running || runner.queueLength > 0) {
          send({ type: "session_status", sessionId: runner.sessionId, running: runner.running, queueLength: runner.queueLength });
        }
        // Replay current compose state (stack error, services, declared
        // secrets) so the UI is correct after a reload / session switch — none
        // of it is re-emitted on its own. See `compose-attach-replay.ts`.
        const mgr = serviceManagers.get(runner.sessionId);
        if (mgr) {
          for (const msg of buildComposeAttachReplay(mgr, runner.sessionId)) send(msg);
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
          });
        }
        // Replay compose-not-configured hint so the preview panel shows
        // the setup prompt after page reload.
        if (!mgr && !warning && composeNotConfigured.has(runner.sessionId)) {
          send({
            type: "compose_not_configured",
            sessionId: runner.sessionId,
          });
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
        // Session-keyed, through the app-lived scheduler — never a timer on a
        // runner. This used to resolve a runner (registry, else the
        // per-connection `attachedRunner`) and return silently when both were
        // empty, which dropped the whole push for a session whose runner was
        // reclaimed between the post-turn commit and the debounce. The scheduler
        // takes the runner's post-turn hold while the push is armed, so the
        // reclaim protection `post-turn-hold.ts` added is unchanged; what it no
        // longer depends on is the timer living on the object being reclaimed.
        // See `services/auto-push-scheduler.ts`.
        //
        // `attachedRunner` survives only as the id fallback for the call sites
        // that pass no session id; it no longer decides anything.
        autoPushScheduler.schedule(git, sessionId ?? attachedRunner?.sessionId);
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

        // The archived guard, the session-agent reconciliation and the
        // evicted-workspace restore all live in `materializeRunner` — shared
        // with the HTTP dispatch path so a session woken by the outer agent
        // (docs/131 reqs 8–10) comes up exactly the way a WS connect brings it
        // up. Everything below the switch is per-connection and stays here.
        // The synchronous half runs before any `await` on purpose: this function
        // is called as `void activateSession(sid)` and the connect handler keeps
        // sending frames right after, so yielding here would push
        // `session_container_freshness` behind them. Only a session whose
        // checkout has to be re-cloned reaches the async half — as was the case
        // before this logic moved out of here.
        const materializeDeps = {
          sessionManager, runnerRegistry, createRepoGit, getBareCacheDir, githubAuthManager, repoStore,
        };
        const sync = materializeRunnerSync(materializeDeps, sid, perConnectionAgentId);
        const outcome = sync.status === "needs-restore"
          ? await finishRestore(materializeDeps, sid, sync)
          : sync;
        if (outcome.status === "ready") {
          attachToRunner(outcome.runner);
        } else if (outcome.status === "restore-failed") {
          // Recovery is genuinely impossible (no remote / bare cache also
          // gone). Surface a terminal, user-visible state instead of booting a
          // doomed container.
          broadcastLog(sid, "server", `Session workspace could not be restored: ${outcome.message}`);
          send({
            type: "session_status",
            sessionId: sid,
            running: false,
            error: "This session's workspace was lost and could not be restored from the repository.",
          });
          detachFromRunner();
          if (dir !== activeSessionDir) activeSessionDir = dir;
          return;
        } else {
          // "archived" — the session's history still loads read-only over HTTP
          // (`GET /history`) — or "no-workspace": nothing to attach to.
          detachFromRunner();
          if (outcome.status === "archived") {
            if (dir !== activeSessionDir) activeSessionDir = dir;
            return;
          }
        }
        if (dir !== activeSessionDir) {
          activeSessionDir = dir;
        }
        if (s?.remoteUrl) {
          prStatusPoller.trackSession(sid, s.remoteUrl);
          void prStatusPoller.forceRefreshSession(sid).catch((err: unknown) => {
            console.error(`[pr-poller] Error on session-activated refresh ${sid}:`, err);
          });
          // Re-seed the PR card's changed-docs strip on (re)connect. notableFiles
          // is git-derived and only pushed transiently — at PR creation and on
          // each post-turn commit (docs/210). The poller's `pr_status` snapshot
          // that rebuilds the card on reload/session-switch carries no
          // notableFiles, so the strip would render its issue chips but drop its
          // doc/config/image chips until the next turn committed. Recompute from
          // the current branch and push a `pr_notable_files` patch now so the
          // strip is correct on first paint. Best-effort + fire-and-forget: a git
          // error just leaves the strip empty until the next commit, and it adds
          // no latency to activation.
          if (dir) {
            const seedDir = dir;
            void (async () => {
              try {
                const git = createGitManager(seedDir);
                const base =
                  prStatusPoller.getStatus(sid)?.baseBranch
                  ?? s.previousMergedPr?.baseBranch
                  ?? await git.getDefaultBranch();
                const notableFiles = await notableFilesForBranch(git, base);
                send({
                  type: "pr_notable_files",
                  sessionId: sid,
                  cardId: `pr-card-${sid}`,
                  notableFiles,
                });
              } catch (err) {
                console.error(`[pr-lifecycle] notableFiles re-seed failed for ${sid}:`, getErrorMessage(err));
              }
            })();
          }
          // docs/218 — push the composer's reset-eligibility signal on activation
          // so the "start from latest base" control can paint immediately for a
          // merged, untouched session (before the user sends a turn). Git-derived
          // and transient (like notableFiles above); recomputed each connect.
          if (dir) {
            const eligibleDir = dir;
            void (async () => {
              try {
                await emitResetEligible(
                  {
                    getSession: (id) => sessionManager.get(id),
                    getPrStatus: (id) => sessionManager.getPrStatus(id),
                    createGitManager,
                  },
                  { sessionId: sid, sessionDir: eligibleDir, origin: "activation", emit: send },
                );
              } catch (err) {
                console.error(`[pre-turn-reset] eligibility signal failed for ${sid}:`, getErrorMessage(err));
              }
            })();
          }
        }
        if (dir) void checkGitIdentity(dir);
        sendContainerFreshness(sid);
        sendSecretBlock(sid);
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

      // `workspaceDir` in this scope is the orchestrator's own root, not this
      // session's clone — the system prompt is a global setting.
      const readSystemPrompt = (): Promise<string | undefined> =>
        readGlobalSystemPrompt(workspaceDir);

      // Wrap broadcastLog so it both buffers (per-session) AND sends to attached WS viewers.
      // The sessionId is captured from the URL — every log line emitted on
      // this connection belongs to this session, so it goes into THIS
      // session's buffer only. This is what isolates one session's terminal
      // panel from another session's logs.
      const sessionBroadcastLog = (source: LogSource, text: string) => {
        broadcastLog(sessionId, source, text); // per-session buffer + durable store
        const msg = agentLogAppend(source, text);
        if (attachedRunner) {
          attachedRunner.emitMessage(msg);
        } else {
          send(msg);
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
        getSelectedReasoning: () => selectedReasoning,
        setSelectedReasoning: (r) => { selectedReasoning = r; },
        clearLogBuffer: () => { clearLogBuffer(sessionId); },
        getRunner: () => attachedRunner,
        getRunnerRegistry: () => runnerRegistry,
        attachToRunner, detachFromRunner,
        sessionManager, chatHistoryManager, createGitManager, createRepoGit,
        githubAuthManager,
        usageManager, authManager, authManagers, runParamsPreps, agentRegistry, credentialStore, providerAccountManager,
        ...(deps.trackerFetchImpl !== undefined ? { trackerFetchImpl: deps.trackerFetchImpl } : {}),
        repoStore, warmSessionForRepo, generateText,
        egressAllowlistStore,
        ...(containerManager ? { containerManager } : {}),
        getSharedRepoDir: getBareCacheDir, checkGitIdentity, readSystemPrompt, scheduleAutoPush,
        prStatusPoller,
        releaseStatusPoller,
        recordAgentRateLimits,
        markSessionAccountExhausted,
        getSubscriptionLimitsSnapshot: () => limitsRegistry?.getSnapshot() ?? {},
        nudgeClaudeOAuthRefresh,
        onAgentAuthRequired,
        ensureAgentTokenFresh,
        workspaceDir, sessionsRoot, defaultAgentId, credentialsDir,
        getServiceManager: () => serviceManagers.get(sessionId) ?? null,
        logStore,
        removeSessionLogs,
      };

      // Auto-activate the session on connect
      void activateSession(sessionId);

      // docs/272-user-selectable-roles reqs 12, 13 — the seeded role's answer,
      // sent for the same reason `set_role`'s is: the row is what the composer
      // displays, and the browser's copy of it predates this connect. Emitted
      // only when the seed actually applied, so an ordinary reconnect adds no
      // frame. It carries the harness, model and level too — the role wrote all
      // four together, and a viewer told about one of them is a row showing a
      // role beside parameters it did not set.
      if (seededRoleApplied) sendSelectionChanged(perConnectionAgentId);

      // Send log buffer and git identity check.
      // Replay only THIS session's buffered entries so a newly-connected
      // viewer doesn't see logs that belong to other sessions.
      //
      // Re-seed the agent Logs channel from the durable store (docs/192) on
      // every WS (re)connect. A single `log_snapshot` REPLACES the client
      // model wholesale — so a reconnect can't duplicate the backlog (the old
      // `clear_logs` + per-entry replay dance is gone), and the snapshot
      // survives orchestrator restart / idle eviction / container destruction,
      // which is what fixes "logs only from the moment I attached". Agent
      // entries are written synchronously (see LogStore.appendEntry), so the
      // file is always complete and current and this can't race a just-emitted
      // line. `<LogView>` also subscribes on mount; both paths send the same
      // idempotent snapshot. Live lines then arrive via `sessionBroadcastLog`.
      send({
        type: "log_snapshot",
        channel: "agent",
        records: logStore.snapshotEntries(sessionId, "agent").map(
          (e): WsLogRecord => ({ ts: e.ts, source: (e.source || undefined) as LogSource | undefined, text: e.text }),
        ),
      });
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
                // docs/202 — a re-armed session (merged → advanced, no new PR
                // yet) carries a `previousMergedPr` breadcrumb. Mirror
                // `emitPrLifecycleAfterCommit`'s base resolution so the diff is
                // measured against the prior PR's base rather than a hardcoded
                // "main", and thread the breadcrumb through: it renders the
                // "previously merged #N" note AND is what lets this card
                // override a viewer's stale terminal merged card in
                // `pr-store.updateCard`'s regress guard.
                const previousMergedPr = session.previousMergedPr;
                const readyBase = previousMergedPr?.baseBranch ?? await git.getDefaultBranch();
                const { insertions, deletions } = await git.diffStatVsBranch(readyBase);
                send({
                  type: "pr_lifecycle_update",
                  sessionId,
                  cardId: `pr-card-${sessionId}`,
                  phase: "ready",
                  headBranch,
                  totalInsertions: insertions,
                  totalDeletions: deletions,
                  ...(previousMergedPr ? { previousMergedPr } : {}),
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
          case "subscribe_logs": return serviceHandlers.handleSubscribeLogs(ctx, msg);
          case "log_clear": { serviceHandlers.handleLogClear(ctx, msg); return; }
          case "set_agent": {
            const agentId = msg.agentId;
            // docs/272 req 15 — see `leaveRoleOnParameterChange`.
            const roleBefore = roleRelevantSnapshot();
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
            // docs/252 phase 3 — see `setAgent` in `services/settings.ts`: the
            // gate is now "has at least one eligible model" (req 8), so the
            // message names that rather than a vendor's env var.
            if (!info.hasRunnableModels) {
              send({
                type: "error",
                message: `${info.name} has no models available. Add a credential for a service it can reach in Settings → Services.`,
              });
              return;
            }
            ctx.setActiveAgentId(agentId);
            // Conform the model and the reasoning effort to the new agent. The
            // harness picker switches the harness without touching either, so
            // without this a Codex → Claude switch would leave a "gpt-5.5"
            // model selected and the next turn would spawn
            // `claude --model gpt-5.5` and fail.
            //
            // docs/252 phase 4 — the test is the whole TRIPLE against the new
            // harness's ELIGIBLE set, not a bare id against its catalogue join.
            // The join says nothing about credentials and nothing about which
            // service the session is on, so an id-only test kept a
            // `(service, mode)` the new harness cannot authenticate with — a
            // selection the picker will not even show. `model-switch.ts` holds
            // the rule and the sentence that reports it.
            const currentReasoning = ctx.getSelectedReasoning();
            const move = conformSelectionToAgent({
              agent: info,
              current: selectionFrom(
                activeAppSessionId ? sessionManager.get(activeAppSessionId) : undefined,
              ),
              currentModelId: ctx.getSelectedModel(),
              currentReasoning,
            });
            if (move.selection) {
              ctx.setSelectedModel(move.selection.modelId);
              if (activeAppSessionId) {
                sessionManager.setModelSelection(activeAppSessionId, move.selection);
              }
            }
            // docs/217 — reasoning is per-agent; a stale value from the previous
            // agent can't apply to the new one. Drop it (back to default) when it
            // isn't in the new agent's option set — reset rather than mapped to
            // a neighbouring level, because a shared level NAME is not a promise
            // of shared semantics and omitting the flag is always valid.
            if (move.reasoningCleared) {
              ctx.setSelectedReasoning(undefined);
              if (activeAppSessionId) {
                sessionManager.setReasoning(activeAppSessionId, null);
              }
            }
            // Persist per-session so reconnects don't pick up the global
            // localStorage agent from another session.
            if (activeAppSessionId) {
              sessionManager.setAgentId(activeAppSessionId, agentId);
            }
            const movedTo = move.selection
              ? info.eligibleModels.find(
                  (m) =>
                    m.serviceId === move.selection!.serviceId
                    && m.billingMode === move.selection!.billingMode
                    && m.modelId === move.selection!.modelId,
                )
              : undefined;
            leaveRoleOnParameterChange(roleBefore);
            sendSelectionChanged(
              agentId,
              describeSelectionMove({
                agentName: info.name,
                move,
                ...(movedTo
                  ? {
                      movedTo: {
                        label: movedTo.label,
                        serviceName: movedTo.serviceName,
                        billingMode: movedTo.billingMode,
                      },
                    }
                  : {}),
              }),
            );
            return;
          }
          case "set_model": {
            // docs/272 req 15 — see `leaveRoleOnParameterChange`. Captured before
            // the handler's own "decide everything before mutating" pass, so a
            // refused triple leaves the role exactly where it was.
            const roleBefore = roleRelevantSnapshot();
            const currentAgentId = ctx.getActiveAgentId();
            const activeAgent = agentRegistry.get(currentAgentId);
            // docs/252 phase 4 — **decide everything before mutating anything.**
            // This handler can self-switch the harness (below), and cross-backend
            // review found the refusal downstream of that: a request refused for
            // its triple had already moved the session to the other harness and
            // reset its reasoning, so "refused" left the session changed in two
            // ways the user did not ask for. Resolve the harness that WOULD run
            // this model first, verify against it, and only then write.
            const modelOwner =
              activeAgent && !activeAgent.capabilities.models.includes(msg.model)
                ? agentRegistry.available().find((a) => a.capabilities.models.includes(msg.model))
                : activeAgent;
            if (activeAgent && !modelOwner) {
              send({ type: "error", message: `Model "${msg.model}" is not available for ${activeAgent.name}` });
              return;
            }
            // docs/252 — persist the SELECTION, not just the model id: a bare id
            // cannot say which service is billing the turn (req 11), because the
            // same id is reachable through a vendor directly, through a gateway,
            // and through two modes of one service.
            //
            // docs/252 phase 4 — an explicit triple is honoured or REFUSED, never
            // re-resolved. Phase 3 fell through to bare-id resolution when the
            // triple was not eligible, which silently landed the session on
            // whichever *other* service offers the same id — the user picks
            // Vercel, has no Vercel key, and gets billed to OpenRouter. The
            // fall-through survives only for a client that sent NEITHER field (an
            // older browser, Quick Capture), where a bare id is all there is;
            // exactly one field is an incoherent request, not a legacy one, and
            // `modelSelectionFrom` refuses it rather than dropping the half it
            // was given. See `model-switch.ts`.
            const verdict = verifyExplicitSelection(
              modelOwner,
              modelSelectionFrom(msg.model, msg.serviceId, msg.billingMode),
            );
            if (verdict && !verdict.ok) {
              // Reported as a notice on the authoritative selection, not as an
              // `error`: the session did not change, so the picker has to be told
              // to drop its optimistic pick — and an `error` renders an assistant
              // bubble that is never persisted, which is transcript content that
              // vanishes on reload.
              sendSelectionChanged(ctx.getActiveAgentId(), verdict.message);
              return;
            }
            if (activeAgent && modelOwner && modelOwner.id !== currentAgentId) {
              // The model isn't in the current agent's lineup. The picker
              // switches harness + model together by firing `set_agent` then
              // `set_model`, so this fires whenever the user crosses a harness
              // boundary (e.g. Codex → Opus). Rather than depend on `set_agent`
              // having already landed — which it may not have, if its
              // auth/install guard bailed or the two messages raced — make
              // `set_model` self-healing and switch to the owner here.
              //
              // docs/138 — after the session has taken its first turn the agent
              // is pinned for life (per-agent credential isolation). The model
              // can still move freely within the pinned agent's lineup, but a
              // cross-agent model is rejected here rather than triggering the
              // silent auto-switch the unpinned flow uses. The UI mirrors this
              // by hiding cross-harness rows; this branch is the authoritative
              // guard.
              if (activeAppSessionId) {
                const pinnedSession = sessionManager.get(activeAppSessionId);
                if (pinnedSession?.agentPinned) {
                  send({
                    type: "error",
                    message: `This session is locked to ${activeAgent.name}. Model "${msg.model}" requires ${modelOwner.name}, which can't be selected after the first message. Switch models within ${activeAgent.name} instead.`,
                  });
                  return;
                }
              }
              ctx.setActiveAgentId(modelOwner.id);
              if (activeAppSessionId) {
                sessionManager.setAgentId(activeAppSessionId, modelOwner.id);
              }
              // docs/217 — `set_model` can cross an agent boundary on its own
              // (the picker fires set_agent + set_model, but they can race or
              // set_agent's guard can bail, and QuickCapture sends set_model
              // alone). Reasoning is per-agent, so self-heal it here too —
              // otherwise a stale Claude `max` could ride a Codex spawn as
              // `-c model_reasoning_effort=max`. Mirrors the set_agent path.
              // docs/274 req 14 — against what the model being MOVED TO honours,
              // not the new harness's vocabulary. The two differ for grok, so a
              // `high` carried over from another harness would survive onto a
              // key-billed grok row and be dropped before the wire every turn.
              const currentReasoning = ctx.getSelectedReasoning();
              if (
                currentReasoning
                && !selectionHonoursEffort(modelOwner.id, verdict?.selection, currentReasoning)
              ) {
                ctx.setSelectedReasoning(undefined);
                if (activeAppSessionId) {
                  sessionManager.setReasoning(activeAppSessionId, null);
                }
              }
            }
            ctx.setSelectedModel(msg.model);
            // Persist to session metadata so it survives reconnects and warm pool.
            if (activeAppSessionId) {
              if (verdict?.ok) {
                sessionManager.setModelSelection(activeAppSessionId, verdict.selection);
              } else {
                // No triple sent. Resolve the id from the catalogue, biased
                // toward the harness's own vendor so a first-party id cannot
                // land on a gateway that happens to list the same string.
                sessionManager.setModel(
                  activeAppSessionId,
                  msg.model,
                  nativeServiceForHarness(ctx.getActiveAgentId()),
                );
              }
            }
            // Confirm what the session now actually holds. The client picks
            // optimistically by triple and the server may have resolved a bare
            // id to a different `(service, mode)` than the picker highlighted —
            // invisible when the two share a model id, which is exactly the case
            // this feature creates. No notice: the user asked for this one.
            leaveRoleOnParameterChange(roleBefore);
            sendSelectionChanged(ctx.getActiveAgentId());
            return;
          }
          case "set_reasoning": {
            // docs/217 — Control B: per-session reasoning effort for the active
            // agent's own turns. `effort: null` clears it (back to the CLI
            // default). Validate against the active agent's option set so a bad
            // value can't reach the spawn; the picker only sends in-set values.
            const reasoningAgent = agentRegistry.get(ctx.getActiveAgentId());
            const effort = msg.effort;
            if (effort !== null) {
              // docs/274 req 14 — validated against this session's SELECTION.
              // The vocabulary is what the CLI understands; whether this row
              // puts it on the wire is a different question, and accepting a
              // level the row discards stores a preference that silently does
              // nothing (the picker no longer offers one, so this is the
              // defence for a stale client or a direct WS caller).
              const active = activeAppSessionId ? sessionManager.get(activeAppSessionId) : undefined;
              const reasoningSelection =
                active?.serviceId && active.billingMode && active.model
                  ? { serviceId: active.serviceId, billingMode: active.billingMode, modelId: active.model }
                  : undefined;
              if (!selectionHonoursEffort(ctx.getActiveAgentId(), reasoningSelection, effort)) {
                send({ type: "error", message: `Invalid reasoning effort "${effort}" for ${reasoningAgent?.name ?? "this agent"}` });
                return;
              }
            }
            const roleBefore = roleRelevantSnapshot();
            ctx.setSelectedReasoning(effort ?? undefined);
            if (activeAppSessionId) {
              sessionManager.setReasoning(activeAppSessionId, effort);
            }
            // docs/272 req 15 — the reasoning level is one of the three a role
            // set, so moving it leaves the role. `sendSelectionChanged` then
            // carries the cleared name; without it the composer would keep
            // showing a role whose level the user has just overridden.
            leaveRoleOnParameterChange(roleBefore);
            sendSelectionChanged(ctx.getActiveAgentId());
            return;
          }
          case "set_role": {
            // docs/272-user-selectable-roles reqs 1, 2, 4, 8, 9, 10, 18 — start this session on a
            // configured role, or take the role off it.
            //
            // **Decide everything before mutating anything**, the rule
            // `set_model` above states: `resolveUserRole` refuses an unknown
            // name, the reserved reviewer, and a role this install cannot run —
            // and a refusal must leave the session exactly as it was, because
            // "your role could not start" plus a session silently moved onto
            // half of it is the worst of both.
            if (!activeAppSessionId) {
              send({ type: "error", message: "No session to apply a role to." });
              return;
            }
            const roleSession = sessionManager.get(activeAppSessionId);
            // req 4 — selectable until the first turn STARTS, and not after.
            // `agentPinned` is that moment: it is set when the first turn
            // provisions per-agent credentials, which is also what makes the
            // harness irreversible. Starting from an issue or forking does not
            // begin a turn, so both land here with the role still selectable —
            // which is exactly the receipt req 4 records.
            if (roleSession?.agentPinned) {
              send({
                type: "error",
                message: "A role can only be chosen before the session's first message.",
              });
              return;
            }
            // req 18 — **"No role" is a choice of role, and it is the whole of
            // this branch.** The three parameters are deliberately left where
            // they are: the role's values are the last thing the user chose, so
            // putting ShipIt's defaults back would undo a choice they did not
            // ask to undo. What clearing takes away is the name and, with it,
            // the standing instructions the first turn would otherwise carry —
            // the one thing no parameter can express.
            if (msg.roleName === null) {
              // `clearRoleName`, not `setRoleName(…, null)`: the row records that
              // the user chose none, so the `?role=` seed cannot put it back on
              // the next reconnect. See that method for why the two clears
              // differ.
              sessionManager.clearRoleName(activeAppSessionId);
              sendSelectionChanged(ctx.getActiveAgentId());
              return;
            }
            let resolvedRole;
            try {
              resolvedRole = resolveUserRole(msg.roleName, { credentialStore });
            } catch (err) {
              send({
                type: "error",
                message: err instanceof ServiceError ? err.message : `Could not start the "${msg.roleName}" role.`,
              });
              return;
            }
            applyRoleToSession(activeAppSessionId, resolvedRole, { sessionManager });
            // The per-connection state has to follow the row, or this turn spawns
            // on whatever the connection was holding: these three are read at
            // spawn time, and the row alone does not reach them.
            ctx.setActiveAgentId(resolvedRole.params.harnessId);
            ctx.setSelectedModel(resolvedRole.params.modelId);
            ctx.setSelectedReasoning(resolvedRole.params.reasoningEffort);
            sendSelectionChanged(resolvedRole.params.harnessId);
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
    image: node:24-slim
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
          case "answer_question": {
            const sessionIdForReset = ctx.getActiveAppSessionId();
            if (sessionIdForReset) {
              prStatusPoller.resetRemediationForUserActivity(sessionIdForReset);
            }
            return sendMessageHandlers.handleAnswerQuestion(ctx, msg);
          }
          case "submit_bug_report": return bugReportHandlers.handleSubmitBugReport(ctx, msg);
          case "dismiss_bug_report": { bugReportHandlers.handleDismissBugReport(ctx, msg); return; }
          case "egress_decision": { egressHandlers.handleEgressDecision(ctx, msg); return; }
          case "resolve_permission": { permissionHandlers.handleResolvePermission(ctx, msg); return; }
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
            if (err instanceof AgentTurnAdmissionError) {
              const requestId = "requestId" in msg && typeof msg.requestId === "string" ? msg.requestId : undefined;
              send({ type: "error", message: err.message, code: err.code, sessionId: err.sessionId, ...(requestId ? { requestId } : {}) });
            } else {
              send({ type: "error", message: err instanceof Error ? err.message : "Request failed" });
            }
          } catch { /* socket may already be closed */ }
        }
      });

      socket.on("close", () => {
        console.log(`[ws] session client disconnected: ${sessionId}`);
        stopKeepalive();
        containerManager?.off("container_started", onContainerStarted);
        detachFromRunner();
        // Intentionally do NOT call enforceIdleContainerLimit() here.
        // WebSocket lifecycle MUST NOT affect runner/container lifecycle —
        // a transient disconnect (network blip, reload, session switch)
        // should never kill the agent or destroy the container. Idle
        // cleanup runs on a periodic timer plus on `runner_idle` events.
      });
    },
  );
}
