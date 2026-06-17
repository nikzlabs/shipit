import type { FastifyInstance } from "fastify";
import path from "node:path";
import fs from "node:fs/promises";
import { getAuthEnvKey } from "../shared/agent-registry.js";
import type { AgentId } from "../shared/types.js";
import type { WsClientMessage, WsServerMessage, WsLogRecord, LogSource } from "../shared/types.js";
import { agentLogAppend } from "./log-emit.js";
import { getErrorMessage } from "./validation.js";
import { getGitIdentity } from "./git-config.js";
import { pushToOrigin, isGitAuthError } from "./git-utils.js";
import { isNonFastForwardError } from "./services/git.js";
import { notableFilesForBranch } from "./services/notable-files.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import { registerPreviewProxy } from "./preview-proxy.js";
import type { ConnectionCtx, RunnerCtx, AppCtx } from "./ws-handlers/types.js";
import * as terminalHandlers from "./ws-handlers/terminal-handlers.js";
import * as miscHandlers from "./ws-handlers/misc-handlers.js";
import * as rollbackHandlers from "./ws-handlers/rollback-handlers.js";
import * as sendMessageHandlers from "./ws-handlers/send-message.js";
import * as bugReportHandlers from "./ws-handlers/bug-report-handlers.js";
import * as egressHandlers from "./ws-handlers/egress-handlers.js";
import * as permissionHandlers from "./ws-handlers/permission-handlers.js";
import * as issueWriteHandlers from "./ws-handlers/issue-write-handlers.js";
import * as serviceHandlers from "./ws-handlers/service-handlers.js";
import { registerApiRoutes } from "./api-routes.js";
import type { GitManager } from "../shared/git.js";
import { readDockerMemoryStats } from "./docker-memory.js";
import { pruneSessionVolumes } from "./disk-janitor.js";
import { ensureCatalogCloned, getCatalogCacheRoot } from "./services/marketplace.js";
import { serveStaticClient } from "./app-assembly.js";
import type { OrchestratorRuntime } from "./bootstrap-managers.js";
import type { StartupMonitors } from "./startup-monitors.js";

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
    sseClients, sessionManager, runnerRegistry, prStatusPoller, releaseStatusPoller,
    githubAuthManager, repoStore, agentRegistry, providerAccountManager, authManagers,
    dockerForStats, limitsRegistry,
    processStartedAt, buildId, version, updateMode,
  } = rt;

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
    // docs/193 (Thread C) — sessions blocked awaiting a permission answer, so
    // the sidebar "needs your approval" attention signal is correct on first
    // paint and survives a reconnect (the worker keeps holding the request).
    const awaitingPermissionSessions: string[] = [];
    for (const session of sessions) {
      const runner = runnerRegistry.get(session.id);
      if (runner?.running) activeRunnerSessions.push(session.id);
      if (runner && runner.awaitingPermissionIds.size > 0) awaitingPermissionSessions.push(session.id);
    }
    client.write(`event: active_runners\ndata: ${JSON.stringify({ sessionIds: activeRunnerSessions })}\n\n`);
    client.write(`event: session_attention\ndata: ${JSON.stringify({ awaitingPermissionSessionIds: awaitingPermissionSessions })}\n\n`);

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
    autoPushDebounceMs, sessionsRoot, agentFactory,
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
    prStatusPoller, releaseStatusPoller, limitsRegistry, recordAgentRateLimits,
    createSessionDir, warmSessionForRepo, waitForWarmSession,
    clientDir, logStore,
  } = rt;
  const { kickDiskEscalation } = monitors;

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
    mergeWatchManager,
    databaseManager,
    secretStore,
    reviewStore,
    egressAllowlistStore,
    presentStore,
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
    removeSessionLogs,
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
  await serveStaticClient(app, clientDir, shouldServeStatic);

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
          // Agent log lines are re-seeded by the `log_snapshot` above, so skip
          // the buffered `log_append`s here to avoid duplicating the backlog.
          if (buffered.type === "log_append") continue;
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
            });
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
            });
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
              runner.emitMessage(agentLogAppend("server", text));
              return;
            }
            const text = errMsg.includes("workflow")
              ? "Auto-push failed: your GitHub token needs the `workflow` scope to push changes to GitHub Actions workflow files. Update your token at https://github.com/settings/tokens."
              : `Auto-push failed: ${errMsg}`;
            broadcastLog(runner.sessionId, "server", text);
            runner.emitMessage(agentLogAppend("server", text));
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

        // Never resurrect or re-track an archived session. A stray WS connection
        // to an archived session id must not `getOrCreate` a runner (which boots
        // a container) or re-arm the PR poller — either would let an archived
        // session start receiving updates again, violating the "archived sessions
        // receive nothing" invariant. The legitimate restore path
        // (`unarchiveSession`) flips `archived` → false BEFORE the client
        // activates, so this only short-circuits genuinely-archived ids; the
        // session's history still loads read-only over HTTP (`GET /history`).
        if (s?.archived || s?.userArchived) {
          detachFromRunner();
          if (dir !== activeSessionDir) activeSessionDir = dir;
          return;
        }
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
                const base =
                  prStatusPoller.getStatus(sid)?.baseBranch ?? s.previousMergedPr?.baseBranch ?? "main";
                const git = createGitManager(seedDir);
                const notableFiles = await notableFilesForBranch(git, seedDir, base);
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
          case "subscribe_logs": return serviceHandlers.handleSubscribeLogs(ctx, msg);
          case "log_clear": { serviceHandlers.handleLogClear(ctx, msg); return; }
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
}
