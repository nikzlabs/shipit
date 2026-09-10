import { reconcileAgentMergeClaims } from "./services/agent-merge-settlement.js";
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

export function registerSseEndpoint(app: FastifyInstance, rt: OrchestratorRuntime): void {
  const {
    sseClients, sessionManager, runnerRegistry, prStatusPoller,
    githubAuthManager, repoStore, agentRegistry, providerAccountManager, authManagers,
    credentialStore,
    dockerForStats, limitsRegistry,
    processStartedAt, buildId, version, updateMode,
  } = rt;
  const originPolicy = readOriginPolicyFromEnv();

  app.get("/api/events", (request, reply) => {
    const headers: Record<string, string> = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // Raw responses bypass the headers set on reply by hooks.
      ...corsHeadersFor(request.headers.origin, request.headers, originPolicy),
      ...frameGuardHeaders(framePolicyFromEnv()),
    };
    reply.raw.writeHead(200, headers);

    const client = {
      write: (data: string) => reply.raw.write(data),
      closed: false,
    };
    sseClients.add(client);

    // Send runner and PR state before session_list to avoid false attention flags.
    const sessions = sessionManager.list();

    // Empty snapshots must clear state left over from a disconnected client.
    const activeRunnerSessions: string[] = [];
    const awaitingPermissionSessions: string[] = [];
    const backgroundTaskSessions: string[] = [];
    // Include warm sessions so viewers detect their replaced runners too.
    const runnerIncarnations: Record<string, number> = {};
    for (const session of sessionManager.listAll()) {
      const incarnation = runnerRegistry.incarnation(session.id);
      if (incarnation > 0) runnerIncarnations[session.id] = incarnation;
    }
    for (const session of sessions) {
      const runner = runnerRegistry.get(session.id);
      if (runner?.running) activeRunnerSessions.push(session.id);
      if (runner && runner.awaitingPermissionIds.size > 0) awaitingPermissionSessions.push(session.id);
      // Include brokered reviews as well as CLI-reported tasks.
      if (runner && runner.backgroundWorkDescriptions.length > 0) backgroundTaskSessions.push(session.id);
    }
    client.write(`event: active_runners\ndata: ${JSON.stringify({ sessionIds: activeRunnerSessions, runnerIncarnations })}\n\n`);
    client.write(`event: session_attention\ndata: ${JSON.stringify({ awaitingPermissionSessionIds: awaitingPermissionSessions, backgroundTaskSessionIds: backgroundTaskSessions })}\n\n`);

    const prStatuses = prStatusPoller.getAllStatuses();
    client.write(`event: pr_status\ndata: ${JSON.stringify({ updates: prStatuses, isSnapshot: true })}\n\n`);

    const rateLimit = githubAuthManager.getRateLimitState();
    if (rateLimit.limited && (rateLimit.resetAt === null || rateLimit.resetAt > Date.now())) {
      client.write(`event: gh_rate_limited\ndata: ${JSON.stringify({ resetAt: rateLimit.resetAt })}\n\n`);
    }

    client.write(`event: session_list\ndata: ${JSON.stringify({ sessions })}\n\n`);
    const repos = repoStore.list();
    client.write(`event: repo_list\ndata: ${JSON.stringify({ repos })}\n\n`);

    client.write(`event: agent_list\ndata: ${JSON.stringify(buildAgentListPayload(agentRegistry, credentialStore, providerAccountManager))}\n\n`);
    client.write(`event: provider_accounts\ndata: ${JSON.stringify({ accounts: providerAccountManager.list() })}\n\n`);

    // Login flows outlive connections; restore each challenge under its account.
    for (const [loginId, mgr] of authManagers) {
      const details = mgr.getPendingPayload();
      if (details) {
        const accountId = mgr.getActiveAccountId() ?? undefined;
        client.write(`event: agent_auth_pending\ndata: ${JSON.stringify({ loginId, ...(accountId ? { accountId } : {}), details })}\n\n`);
      }
    }

    client.write(`event: system_info\ndata: ${JSON.stringify({ processStartedAt, buildId, version, updateMode })}\n\n`);

    if (dockerForStats) {
      void (async () => {
        const stats = await readDockerMemoryStats(dockerForStats);
        if (stats && !client.closed) {
          client.write(`event: docker_memory\ndata: ${JSON.stringify(stats)}\n\n`);
        }
      })();
    }

    if (limitsRegistry) {
      const snapshot = limitsRegistry.getSnapshot();
      if (Object.keys(snapshot).length > 0) {
        client.write(`event: subscription_limits\ndata: ${JSON.stringify({ limits: snapshot })}\n\n`);
      }
    }

    const stopKeepalive = startSseKeepalive(client);

    request.raw.on("close", () => {
      client.closed = true;
      stopKeepalive();
      sseClients.delete(client);
    });
  });
}

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
  const { agentMergeClaims, agentMergeExecutor } = rt;
  const wsOriginPolicy = readOriginPolicyFromEnv();

  await registerApiRoutes(app, {
    sessionManager,
    cancelAutoPush: (sessionId: string) => autoPushScheduler.cancel(sessionId),
    scheduleAutoPush: (git: GitManager, sessionId?: string) => autoPushScheduler.schedule(git, sessionId),
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
    agentMergeClaims,
    agentMergeExecutor,
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
          forgetSubscriptionLimits: (modeKey: string, routeId: string) =>
            limitsRegistry.markSignedOut(modeKey, routeId),
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
    egressEnforcementActive: egressEnforcementActive(),
    egressEnforcementStatus: egressEnforcementStatus(),
    reconcileSessionEgress: (sid: string) => reconcileSessionEgress(
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
          sseBroadcast,
        },
      },
      sid,
    ),
    egressDnsControlDeployed: egressDnsEnabled(),
    presentStore,
    serviceManagers,
    composeStopPromises,
    refreshPluginReposForSession,
    runPluginCommandForSession,
    // Tests must not invoke Docker or an agent CLI.
    pruneSessionVolumes: isTestMode ? undefined : pruneSessionVolumes,
    ...(isTestMode ? { bugReportModelRunner: async () => null } : {}),
    getLogBuffer,
    removeSessionLogs,
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

  if (!isTestMode) {
    const cacheRoot = getCatalogCacheRoot(stateDir);
    for (const mkt of marketplaceStore.list()) {
      void ensureCatalogCloned(marketplaceStore, mkt.id, cacheRoot).catch((err: unknown) => {
        console.warn(
          `[marketplace] pre-clone failed for ${mkt.id}:`,
          (err as Error).message,
        );
      });
    }
  }

  if (containerManager) {
    registerPreviewProxy(app, { containerManager, serviceManagers, runnerRegistry, broadcastLog });
    // Exempt preview hosts from the API origin guard only when this proxy exists.
    markPreviewProxyRegistered(app);
  }

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
          turnEventBufferSize: runner.getTurnEventBuffer().length,
          turnEventBufferTypes: runner.getTurnEventBuffer().map((m) => m.type),
        };
      },
    );

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

  await serveStaticClient(app, clientDir, shouldServeStatic);

  app.get<{ Params: { sessionId: string }; Querystring: { agent?: string; model?: string; reasoning?: string; service?: string; billingMode?: string; role?: string } }>(
    "/ws/sessions/:sessionId",
    { websocket: true },
    (socket, request) => {
      const { sessionId } = request.params;
      // CORS does not protect WebSocket handshakes.
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

      const stopKeepalive = startWebSocketKeepalive(socket, {
        onUnresponsive: () => {
          console.log(`[ws] session client unresponsive, terminating: ${sessionId}`);
        },
      });

      let activeAppSessionId: string | undefined = sessionId;
      let activeSessionDir: string | null = session.workspaceDir ?? null;
      // Browser seeds apply only to unpinned sessions; persisted choices take precedence.
      let perConnectionAgentId: AgentId;
      let selectedModel: string | undefined;
      let agentRerouteNotice: string | undefined;
      // Resolve retirements before an unknown model can fall back to models[0].
      const sessionModel = applyModelRetirement(
        sessionManager,
        session,
        session.agentId ?? (request.query.agent as AgentId | undefined) ?? defaultAgentId,
      );
      if (session.agentPinned) {
        perConnectionAgentId = session.agentId ?? defaultAgentId;
        const agentInfo = agentRegistry.get(perConnectionAgentId);
        selectedModel = sessionModel ?? agentInfo?.capabilities.models[0];
        if (selectedModel && agentInfo && !agentInfo.capabilities.models.includes(selectedModel)) {
          selectedModel = agentInfo.capabilities.models[0];
        }
      } else {
        const requestedAgent = request.query.agent as AgentId | undefined;
        const requestedModel = request.query.model;
        perConnectionAgentId = session.agentId ?? requestedAgent ?? defaultAgentId;
        selectedModel = sessionModel ?? requestedModel;
        const model = selectedModel;
        // A role fixes the harness; reconnects must not derive another one.
        const roleDecidesHarness = !!session.roleName;
        // Prefer a named, installed harness that supports the model over registry order.
        const namedAgents = [session.agentId, requestedAgent].filter(
          (id): id is AgentId => !!id,
        );
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
      if (!session.agentPinned && perConnectionAgentId !== session.agentId) {
        try { sessionManager.setAgentId(sessionId, perConnectionAgentId); } catch { /* ignore */ }
        // Append once per persisted reroute without replacing branch or LFS notices.
        if (agentRerouteNotice) {
          try {
            sessionManager.appendPendingAgentNotice(sessionId, agentRerouteNotice);
          } catch { /* ignore */ }
        }
      }
      if (selectedModel && selectedModel !== sessionModel) {
        // A fallback model must not inherit the browser seed's service.
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
          // Browser seeds can outlive the credentials that made them eligible.
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
      const requestedReasoning =
        !session.agentPinned && typeof request.query.reasoning === "string"
          ? request.query.reasoning
          : undefined;
      let selectedReasoning: string | undefined = session.reasoningEffort ?? requestedReasoning;
      {
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
      // Remove the role name if reconciliation changed its parameters.
      if (
        session.roleName
        && (perConnectionAgentId !== session.agentId
          || selectedModel !== session.model
          || (selectedReasoning ?? undefined) !== (session.reasoningEffort ?? undefined))
      ) {
        try { sessionManager.setRoleName(sessionId, null); } catch { /* ignore */ }
      }

      // Apply a role last so its parameters replace the separate browser seeds.
      const requestedRole =
        typeof request.query.role === "string" && request.query.role.length > 0
          ? request.query.role
          : undefined;
      // A stale WebSocket URL must not restore a role the user explicitly cleared.
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
          // An unavailable browser seed does not prevent connection.
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

      const sendSecretBlock = (sid: string) => {
        send({
          type: "secret_block_status",
          sessionId: sid,
          block: sessionManager.getSecretBlock(sid) ?? null,
        });
      };

      // Report persisted values without buffering a selection that could become stale.
      const sendSelectionChanged = (agentId: AgentId, notice?: string): void => {
        const session = activeAppSessionId ? sessionManager.get(activeAppSessionId) : undefined;
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
          roleName: session.roleName ?? null,
          ...(notice ? { notice } : {}),
        });
      };

      // Rejected or unchanged parameter picks must preserve the role.
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

      const attachToRunner = (runner: SessionRunnerInterface) => {
        if (attachedRunner === runner) return;
        detachFromRunner();
        attachedRunner = runner;
        runnerMessageListener = (msg: WsServerMessage) => { send(msg); };
        runner.on("message", runnerMessageListener);
        runner.attachViewer();
        // Viewing affects disk cleanup, not lastUsedAt or the Active session list.
        sessionManager.setLastViewedAt(runner.sessionId);
        prStatusPoller.notifyViewerAttached();
        releaseStatusPoller.notifyViewerAttached();
        // Subscribe and snapshot synchronously so no turn events fall between them.
        if (runner.running) {
          send({
            type: "turn_snapshot",
            sessionId: runner.sessionId,
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
        // Transcript snapshots, log snapshots, and xterm handle their own replay.
        for (const buffered of runner.getTurnEventBuffer().slice(runner.lastPersistedBufferIndex)) {
          if (buffered.type === "agent_event") continue;
          if (buffered.type === "turn_snapshot") continue;
          if (buffered.type === "log_append") continue;
          if (buffered.type === "terminal_output") continue;
          if (buffered.type === "terminal_exit") continue;
          if (buffered.type === "terminal_reconnecting") continue;
          // HTTP history carries current tasks; buffered tasks can be stale.
          if (buffered.type === "background_tasks") continue;
          // Keep system_user_message for its activity label; clientRequestId deduplicates it.
          send(buffered);
        }
        // An empty queue snapshot clears messages drained while disconnected.
        send({ type: "queue_updated", queue: runner.getQueueSnapshot() });
        if (runner.running || runner.queueLength > 0) {
          send({ type: "session_status", sessionId: runner.sessionId, running: runner.running, queueLength: runner.queueLength });
        }
        const mgr = serviceManagers.get(runner.sessionId);
        if (mgr) {
          for (const msg of buildComposeAttachReplay(mgr, runner.sessionId)) send(msg);
        }
        if (runner.presentations && runner.presentations.length > 0) {
          send({
            type: "present_state",
            sessionId: runner.sessionId,
            presentations: runner.presentations,
          });
        }
        const warning = composeWarnings.get(runner.sessionId);
        if (warning && !mgr) {
          send({
            type: "compose_error",
            sessionId: runner.sessionId,
            message: warning,
          });
        }
        if (!mgr && !warning && composeNotConfigured.has(runner.sessionId)) {
          send({
            type: "compose_not_configured",
            sessionId: runner.sessionId,
          });
        }
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
          prStatusPoller.notifyViewerDetached();
          releaseStatusPoller.notifyViewerDetached();
        }
        attachedRunner = null;
        runnerMessageListener = null;
        previewRetryListener = null;
      };

      const scheduleAutoPush = (git: GitManager, sessionId?: string) => {
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

        // Keep normal attachment synchronous to preserve the connect-frame order.
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
          detachFromRunner();
          if (outcome.status === "archived") {
            if (dir !== activeSessionDir) activeSessionDir = dir;
            return;
          }
        }
        if (dir !== activeSessionDir) {
          activeSessionDir = dir;
        }
        void reconcileAgentMergeClaims({
          claims: agentMergeClaims,
          sessionManager,
          chatHistoryManager,
          prStatusPoller,
          runnerRegistry,
        }, { sessionId: sid }).catch((err: unknown) => {
          console.error(`[agent-merge] activation reconciliation for ${sid} failed:`, err);
        });
        if (s?.remoteUrl) {
          prStatusPoller.trackSession(sid, s.remoteUrl);
          void prStatusPoller.forceRefreshSession(sid).catch((err: unknown) => {
            console.error(`[pr-poller] Error on session-activated refresh ${sid}:`, err);
          });
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
        kickDiskEscalation(sid);
      };

      const checkGitIdentity = async (_sessionDir: string) => {
        if (getGitIdentity()) return;
        send({ type: "git_identity_required" });
      };

      // The global prompt belongs to the orchestrator workspace.
      const readSystemPrompt = (): Promise<string | undefined> =>
        readGlobalSystemPrompt(workspaceDir);

      const sessionBroadcastLog = (source: LogSource, text: string) => {
        broadcastLog(sessionId, source, text);
        const msg = agentLogAppend(source, text);
        if (attachedRunner) {
          attachedRunner.emitMessage(msg);
        } else {
          send(msg);
        }
      };

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

      void activateSession(sessionId);

      if (seededRoleApplied) sendSelectionChanged(perConnectionAgentId);

      send({
        type: "log_snapshot",
        channel: "agent",
        records: logStore.snapshotEntries(sessionId, "agent").map(
          (e): WsLogRecord => ({ ts: e.ts, source: (e.source || undefined) as LogSource | undefined, text: e.text }),
        ),
      });
      if (!getGitIdentity()) { send({ type: "git_identity_required" }); }

      {
        const runner = runnerRegistry.get(sessionId);
        if (runner?.previewStatusKnown) {
          send(runner.buildPreviewStatus());
        }
      }

      {
        const session = sessionManager.get(sessionId);
        if (session?.remoteUrl && session.workspaceDir && session.branchRenamed) {
          const prStatus = prStatusPoller.getStatus(sessionId);
          if (!prStatus && !session.mergedAt) {
            void (async () => {
              try {
                const git = createGitManager(session.workspaceDir!);
                const headBranch = session.branch || await git.getCurrentBranch();
                // previousMergedPr lets the client replace a stale merged card.
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

      const dispatchSessionMessage = (msg: WsClientMessage): void | Promise<void> => {
        switch (msg.type) {
          case "terminal_start": return terminalHandlers.handleTerminalStart(ctx, msg);
          case "terminal_input": return terminalHandlers.handleTerminalInput(ctx, msg);
          case "terminal_resize": return terminalHandlers.handleTerminalResize(ctx, msg);
          case "subscribe_logs": return serviceHandlers.handleSubscribeLogs(ctx, msg);
          case "log_clear": { serviceHandlers.handleLogClear(ctx, msg); return; }
          case "set_agent": {
            const agentId = msg.agentId;
            const roleBefore = roleRelevantSnapshot();
            // Credential provisioning pins the harness for the session's lifetime.
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
            if (!info.hasRunnableModels) {
              send({
                type: "error",
                message: `${info.name} has no models available. Add a credential for a service it can reach in Settings → Services.`,
              });
              return;
            }
            ctx.setActiveAgentId(agentId);
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
            if (move.reasoningCleared) {
              ctx.setSelectedReasoning(undefined);
              if (activeAppSessionId) {
                sessionManager.setReasoning(activeAppSessionId, null);
              }
            }
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
            const roleBefore = roleRelevantSnapshot();
            const currentAgentId = ctx.getActiveAgentId();
            const activeAgent = agentRegistry.get(currentAgentId);
            // Validate the full selection before changing any session parameter.
            const modelOwner =
              activeAgent && !activeAgent.capabilities.models.includes(msg.model)
                ? agentRegistry.available().find((a) => a.capabilities.models.includes(msg.model))
                : activeAgent;
            if (activeAgent && !modelOwner) {
              send({ type: "error", message: `Model "${msg.model}" is not available for ${activeAgent.name}` });
              return;
            }
            const verdict = verifyExplicitSelection(
              modelOwner,
              modelSelectionFrom(msg.model, msg.serviceId, msg.billingMode),
            );
            if (verdict && !verdict.ok) {
              // Restore the picker's optimistic value to the unchanged session selection.
              sendSelectionChanged(ctx.getActiveAgentId(), verdict.message);
              return;
            }
            if (activeAgent && modelOwner && modelOwner.id !== currentAgentId) {
              // set_model can arrive without a successful set_agent.
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
            if (activeAppSessionId) {
              if (verdict?.ok) {
                sessionManager.setModelSelection(activeAppSessionId, verdict.selection);
              } else {
                sessionManager.setModel(
                  activeAppSessionId,
                  msg.model,
                  nativeServiceForHarness(ctx.getActiveAgentId()),
                );
              }
            }
            leaveRoleOnParameterChange(roleBefore);
            sendSelectionChanged(ctx.getActiveAgentId());
            return;
          }
          case "set_reasoning": {
            const reasoningAgent = agentRegistry.get(ctx.getActiveAgentId());
            const effort = msg.effort;
            if (effort !== null) {
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
            leaveRoleOnParameterChange(roleBefore);
            sendSelectionChanged(ctx.getActiveAgentId());
            return;
          }
          case "set_role": {
            if (!activeAppSessionId) {
              send({ type: "error", message: "No session to apply a role to." });
              return;
            }
            const roleSession = sessionManager.get(activeAppSessionId);
            if (roleSession?.agentPinned) {
              send({
                type: "error",
                message: "A role can only be chosen before the session's first message.",
              });
              return;
            }
            // Clearing a role preserves its parameters but removes its instructions.
            if (msg.roleName === null) {
              // Record the explicit clear so reconnects cannot restore the browser seed.
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
            // Spawn reads connection state as well as the persisted row.
            ctx.setActiveAgentId(resolvedRole.params.harnessId);
            ctx.setSelectedModel(resolvedRole.params.modelId);
            ctx.setSelectedReasoning(resolvedRole.params.reasoningEffort);
            sendSelectionChanged(resolvedRole.params.harnessId);
            return;
          }
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
            // Synthetic messages must not reset the remediation budget.
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
          // Await returned promises so handler rejections reach this catch.
          await dispatchSessionMessage(msg);
        } catch (err) {
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
        // Disconnects must not stop agents or dispose runners and containers.
      });
    },
  );
}
