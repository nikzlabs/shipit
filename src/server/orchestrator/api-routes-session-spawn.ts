import { randomUUID } from "node:crypto";
import { etagFor, matchesIfNoneMatch } from "./http-etag.js";
import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { emitChatCard } from "./chat-card-persistence.js";
import { prepareShipitFixSpawn } from "./api-routes-shipit-fix.js";

import {
  getGitLog,
  getUsageStats,
  listWorktrees,
  getChatHistory,
  spawnChildSession,
  parseSpawnTarget,
  listSpawnedChildren,
  getSpawnedChild,
  sendChildMessage,
  ResolvedChildMessageError,
  waitForChildIdle,
  assertArchivableChild,
  registerMergeWatch,
  armSelfMergeWatch,
  cancelSelfMergeWatch,
  deliverSessionReport,
  resolveSessionCohort,
  archiveSession,
  DEFAULT_WAIT_FOR_CHILD_IDLE_MS,
  MAX_WAIT_FOR_CHILD_IDLE_MS,
  ServiceError,
  recordSpawnInvocation,
  classifySpawnFailure,
  createClaimSessionService,
  DEFAULT_MAX_SHIPIT_FIX_SESSIONS_PER_TURN,
} from "./services/index.js";
import type { AgentId } from "../shared/types.js";
import { getErrorMessage } from "./validation.js";

// Bump when row decoding, selection, wire projection, or payload assembly changes
// without a data write; transcriptRevision cannot invalidate those cached responses.
const HISTORY_VALIDATOR_VERSION = 1;

export async function registerSessionSpawnRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const { sessionManager, createGitManager, createRepoGit } = deps;

  const graduationDeps = {
    sessionManager,
    runnerRegistry: deps.runnerRegistry,
    repoStore: deps.repoStore,
    createGitManager,
    ...(deps.prStatusPoller ? { prStatusPoller: deps.prStatusPoller } : {}),
    sseBroadcast: deps.sseBroadcast,
    ...(deps.ensureAgentTokenFresh ? { ensureAgentTokenFresh: deps.ensureAgentTokenFresh } : {}),
    providerAccountManager: deps.providerAccountManager,
    ...(deps.credentialsDir ? { credentialsDir: deps.credentialsDir } : {}),
    credentialStore: deps.credentialStore,
    chatHistoryManager: deps.chatHistoryManager,
    usageManager: deps.usageManager,
  };

  // Share the claim service: its per-repo lock lives in the instance's closure.
  const claimSessionService = deps.claimSessionService ?? createClaimSessionService({
    sessionManager,
    repoStore: deps.repoStore,
    createGitManager: deps.createGitManager,
    createRepoGit,
    githubAuthManager: deps.githubAuthManager,
    getSharedRepoDir: deps.getSharedRepoDir,
    createSessionDirFull: deps.createSessionDirFull,
    sseBroadcast: deps.sseBroadcast,
    ...(deps.warmSessionForRepo ? { warmSessionForRepo: deps.warmSessionForRepo } : {}),
    ...(deps.waitForWarmSession ? { waitForWarmSession: deps.waitForWarmSession } : {}),
    ...(deps.shouldSkipClaimFetch ? { shouldSkipClaimFetch: deps.shouldSkipClaimFetch } : {}),
    ...(deps.containerManager ? { containerManager: deps.containerManager } : {}),
    ...(deps.egressAllowlistStore ? { egressAllowlistStore: deps.egressAllowlistStore } : {}),
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/history", async (request, reply) => {
    const session = sessionManager.get(request.params.id);
    if (!session) {
      reply.code(404).send({ error: "Session not found" });
      return;
    }
    let commits: Awaited<ReturnType<typeof getGitLog>> = [];
    if (session.workspaceDir) {
      try {
        const git = createGitManager(session.workspaceDir);
        commits = await getGitLog(git);
      } catch {
        // No git repo — empty log
      }
    }

    const runner = deps.runnerRegistry.get(request.params.id);
    const agentRunning = runner?.running ?? false;
    const backgroundTasks = runner?.backgroundWorkDescriptions ?? [];
    const rewindSnapshot = deps.chatHistoryManager.latestRewindSnapshot(request.params.id);

    const turnUsage = deps.usageManager.getPerTurnUsage(request.params.id);
    const sessionUsage = deps.usageManager.getSessionUsage(request.params.id) ?? null;
    const tokenTotals = deps.usageManager.getSessionTokenTotals(request.params.id);

    const presentations = deps.presentStore?.listForClient(request.params.id) ?? [];

    const rest = {
      commits,
      agentRunning,
      backgroundTasks,
      rewindSnapshot,
      turnUsage,
      sessionUsage,
      cumulativeInputTokens: tokenTotals?.cumulativeInputTokens,
      cumulativeOutputTokens: tokenTotals?.cumulativeOutputTokens,
      presentations,
    };

    // Include every response source in the validator without loading the transcript.
    const transcriptRevision = deps.chatHistoryManager.transcriptRevision(request.params.id);
    const etag = etagFor(JSON.stringify([
      HISTORY_VALIDATOR_VERSION,
      request.params.id,
      transcriptRevision,
      rest,
    ]));
    if (matchesIfNoneMatch(request.headers["if-none-match"], etag)) {
      reply.header("etag", etag).code(304).send();
      return;
    }
    // Use persisted rows only; adding runner.chatMessageGroups would duplicate live WS content.
    const messages = getChatHistory(deps.chatHistoryManager, request.params.id) as unknown as Record<string, unknown>[];
    const body = JSON.stringify({ messages, ...rest });
    reply.header("etag", etag).header("cache-control", "no-cache").type("application/json");
    return reply.send(body);
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/usage", async (request, reply) => {
    const session = sessionManager.get(request.params.id);
    if (!session) {
      reply.code(404).send({ error: "Session not found" });
      return;
    }
    return { stats: getUsageStats(deps.usageManager) };
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/worktrees", async (request, reply) => {
    const session = sessionManager.get(request.params.id);
    if (!session) {
      reply.code(404).send({ error: "Session not found" });
      return;
    }
    return { worktrees: listWorktrees(sessionManager, request.params.id) };
  });

  app.get<{
    Params: { id: string; presentId: string };
  }>("/api/sessions/:id/present/:presentId/content", async (request, reply) => {
    const session = sessionManager.get(request.params.id);
    if (!session) {
      reply.code(404).send({ error: "Session not found" });
      return;
    }
    const runner = deps.runnerRegistry.get(request.params.id);
    if (!runner) {
      reply.code(404).send({ error: "Session is not active" });
      return;
    }
    const proxy = runner as { proxyPresentRaw?: (id: string) => Promise<unknown> };
    if (typeof proxy.proxyPresentRaw !== "function") {
      reply.code(501).send({ error: "Present content is not supported on this runner" });
      return;
    }
    try {
      const result = await proxy.proxyPresentRaw(request.params.presentId) as {
        content: string;
        mimeType: string;
      };
      reply.header("Cache-Control", "no-store");
      return result;
    } catch (err) {
      const message = getErrorMessage(err);
      if (/not found|no longer on disk/i.test(message)) {
        reply.code(404).send({ error: message });
        return;
      }
      reply.code(500).send({ error: `Failed to fetch presentation: ${message}` });
    }
  });

  app.post<{
    Params: { parentId: string };
    Body: {
      prompt?: string;
      title?: string;
      agent?: AgentId;
      model?: string;
      role?: string;
      noRole?: boolean;
      agentId?: string;
      serviceId?: string;
      billingMode?: string;
      modelId?: string;
      reasoningEffort?: string;
      spawnedByTurn?: string;
      detached?: boolean;
      shipitSource?: boolean;
      approximateSource?: boolean;
    };
  }>(
    "/api/sessions/:parentId/spawn",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const body = request.body ?? {};
      const parentAgentId = sessionManager.get(request.params.parentId)?.agentId;
      const effectiveAgentId =
        ((body.agentId ?? body.agent) as AgentId | undefined) ?? parentAgentId ?? deps.defaultAgentId;
      try {
        const { effectivePrompt, sourceBase, repoUrlOverride, shipitFixMeta } =
          await prepareShipitFixSpawn(deps, request.params.parentId, body);

        // Preserve empty overrides so the shared parser rejects them instead of inheriting defaults.
        const aliasedAgentId = body.agentId ?? body.agent;
        const aliasedModelId = body.modelId ?? body.model;
        const target = parseSpawnTarget(
          {
            ...(body.role !== undefined ? { role: body.role } : {}),
            ...(body.noRole !== undefined ? { noRole: body.noRole } : {}),
            ...(aliasedAgentId !== undefined ? { agentId: aliasedAgentId } : {}),
            ...(body.serviceId !== undefined ? { serviceId: body.serviceId } : {}),
            ...(body.billingMode !== undefined ? { billingMode: body.billingMode } : {}),
            ...(aliasedModelId !== undefined ? { modelId: aliasedModelId } : {}),
            ...(body.reasoningEffort !== undefined ? { reasoningEffort: body.reasoningEffort } : {}),
          },
          { parentBase: true },
        );

        const result = await spawnChildSession(
          sessionManager,
          deps.runnerRegistry,
          claimSessionService,
          request.params.parentId,
          {
            prompt: effectivePrompt,
            ...(body.title !== undefined ? { title: body.title } : {}),
            ...(sourceBase !== undefined ? { base: sourceBase } : {}),
            target,
            ...(body.spawnedByTurn !== undefined ? { spawnedByTurn: body.spawnedByTurn } : {}),
            ...(body.detached ? { detached: true } : {}),
            ...(repoUrlOverride !== undefined ? { repoUrlOverride } : {}),
            ...(body.shipitSource
              ? { maxSpawnedSessionsPerTurn: DEFAULT_MAX_SHIPIT_FIX_SESSIONS_PER_TURN }
              : {}),
          },
          deps.defaultAgentId,
          deps.credentialsDir,
          deps.credentialStore,
          deps.providerAccountManager,
          graduationDeps,
        );
        const parentRunner = body.detached ? undefined : deps.runnerRegistry.get(request.params.parentId);
        if (parentRunner) {
          const spawnedSession = {
            childSessionId: result.sessionId,
            title: result.session.title,
            ...(result.branch ? { branch: result.branch } : {}),
            spawnedAt: result.session.createdAt,
            ...(shipitFixMeta ? { shipitFix: shipitFixMeta } : {}),
          };
          emitChatCard(
            parentRunner,
            { type: "session_spawned", sessionId: request.params.parentId, ...spawnedSession },
            { role: "assistant", text: "", spawnedSession },
            { chatHistoryManager: deps.chatHistoryManager, sessionId: request.params.parentId },
          );
        }

        recordSpawnInvocation({
          parentSessionId: request.params.parentId,
          ...(body.spawnedByTurn ? { spawnedByTurn: body.spawnedByTurn } : {}),
          agentId: result.agentId,
          outcome: "success",
          statusCode: 200,
          childSessionId: result.sessionId,
        });

        return {
          sessionId: result.sessionId,
          branch: result.branch,
          status: "running" as const,
          session: result.session,
        };
      } catch (err) {
        const statusCode = err instanceof ServiceError ? err.statusCode : 500;
        const errorMessage = err instanceof ServiceError
          ? err.message
          : `Failed to spawn child session: ${getErrorMessage(err)}`;

        const parentRunner = body.detached ? undefined : deps.runnerRegistry.get(request.params.parentId);
        if (parentRunner) {
          const promptPreview = (body.prompt ?? "")
            .trim()
            .split(/\r?\n/)[0]
            .slice(0, 200);
          const spawnFailed = {
            id: `spawn-failed-${randomUUID()}`,
            message: errorMessage,
            statusCode,
            reason: classifySpawnFailure(statusCode, errorMessage),
            ...(body.title ? { title: body.title } : {}),
            ...(promptPreview ? { promptPreview } : {}),
            ...(body.shipitSource ? { shipitSource: true } : {}),
            failedAt: new Date().toISOString(),
          };
          emitChatCard(
            parentRunner,
            { type: "session_spawn_failed", sessionId: request.params.parentId, ...spawnFailed },
            { role: "assistant", text: "", spawnFailed },
            { chatHistoryManager: deps.chatHistoryManager, sessionId: request.params.parentId },
          );
        }

        recordSpawnInvocation({
          parentSessionId: request.params.parentId,
          ...(body.spawnedByTurn ? { spawnedByTurn: body.spawnedByTurn } : {}),
          agentId: effectiveAgentId,
          outcome: classifySpawnFailure(statusCode, errorMessage),
          statusCode,
          errorMessage,
        });

        reply.code(statusCode).send({ error: errorMessage });
      }
    },
  );

  const childProjections = {
    chatHistoryManager: deps.chatHistoryManager,
    prStatusPoller: deps.prStatusPoller,
  };

  app.get<{
    Params: { parentId: string };
    Querystring: { turn?: string };
  }>(
    "/api/sessions/:parentId/children",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const parent = sessionManager.get(request.params.parentId);
      if (!parent) {
        reply.code(404).send({ error: "Parent session not found" });
        return;
      }
      const children = listSpawnedChildren(
        sessionManager,
        deps.runnerRegistry,
        request.params.parentId,
        request.query.turn,
        childProjections,
      );
      return { children };
    },
  );

  app.get<{
    Params: { parentId: string; childId: string };
    Querystring: { wait?: string; timeout?: string; segment?: string };
  }>(
    "/api/sessions/:parentId/children/:childId",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      try {
        if (request.query.wait === "true") {
          const requestedTimeoutSecs = Number(request.query.timeout);
          const timeoutMs = Number.isFinite(requestedTimeoutSecs) && requestedTimeoutSecs > 0
            ? Math.min(Math.floor(requestedTimeoutSecs * 1000), MAX_WAIT_FOR_CHILD_IDLE_MS)
            : DEFAULT_WAIT_FOR_CHILD_IDLE_MS;
          const requestedSegmentSecs = Number(request.query.segment);
          const segmentMs = Number.isFinite(requestedSegmentSecs) && requestedSegmentSecs > 0
            ? Math.min(Math.floor(requestedSegmentSecs * 1000), MAX_WAIT_FOR_CHILD_IDLE_MS)
            : undefined;
          const result = await waitForChildIdle(
            sessionManager,
            deps.runnerRegistry,
            request.params.parentId,
            request.params.childId,
            { timeoutMs, ...(segmentMs !== undefined ? { segmentMs } : {}), projections: childProjections },
          );
          return {
            child: result.child,
            idle: result.idle,
            timedOut: result.timedOut,
            pending: result.pending,
            outcome: result.outcome,
          };
        }
        const child = getSpawnedChild(
          sessionManager,
          deps.runnerRegistry,
          request.params.parentId,
          request.params.childId,
          childProjections,
        );
        return { child };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to read child session: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{
    Params: { parentId: string; childId: string };
    Body: { text?: string };
  }>(
    "/api/sessions/:parentId/children/:childId/message",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      try {
        const result = await sendChildMessage(
          sessionManager,
          deps.runnerRegistry,
          request.params.parentId,
          request.params.childId,
          request.body?.text ?? "",
          deps.defaultAgentId,
          deps.credentialsDir,
          deps.credentialStore,
          deps.providerAccountManager,
          deps.containerManager,
        );
        return { queuePosition: result.queuePosition, enqueued: result.enqueued };
      } catch (err) {
        if (err instanceof ResolvedChildMessageError) {
          reply.code(409).send({
            error: err.message,
            sessionId: err.child.id,
            title: err.child.title,
            reason: "resolved",
            delivered: false,
          });
          return;
        }
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to send child message: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{
    Params: { parentId: string; childId: string };
  }>(
    "/api/sessions/:parentId/children/:childId/archive",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      try {
        assertArchivableChild(
          sessionManager,
          deps.runnerRegistry,
          request.params.parentId,
          request.params.childId,
        );
        const result = await archiveSession(
          sessionManager,
          deps.runnerRegistry,
          deps.getSharedRepoDir,
          request.params.childId,
          deps.pruneSessionVolumes,
          deps.containerManager,
          deps.removeSessionLogs,
        );
        deps.sseBroadcast("session_list", { sessions: result.sessions });
        return { archived: true, sessions: result.sessions };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to archive child session: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{
    Params: { parentId: string; childId: string };
  }>(
    "/api/sessions/:parentId/children/:childId/notify-on-merge",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      try {
        const result = registerMergeWatch(
          sessionManager,
          request.params.parentId,
          request.params.childId,
        );
        // A PR resolved before registration will not trigger a new poller transition.
        if (deps.mergeWatchManager) {
          void deps.mergeWatchManager.checkAndFireNow(request.params.childId).catch((err: unknown) => {
            console.error(`[merge-watch] register-time check failed for ${request.params.childId}:`, err);
          });
        }
        return { armed: true, state: result.state, alreadyArmed: result.alreadyArmed };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to register merge watch: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/notify-on-merge-self",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      try {
        const result = await armSelfMergeWatch(
          {
            sessionManager,
            githubAuthManager: deps.githubAuthManager,
            createGitManager,
            runnerRegistry: deps.runnerRegistry,
            chatHistoryManager: deps.chatHistoryManager,
            ...(deps.mergeWatchManager ? { mergeWatchManager: deps.mergeWatchManager } : {}),
          },
          request.params.sessionId,
        );
        return { armed: true, ...result };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to arm self merge-watch: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Params: { sessionId: string }; Body: { watchId?: string } }>(
    "/api/sessions/:sessionId/notify-on-merge-self/cancel",
    async (request, reply) => {
      const watchId = request.body?.watchId;
      if (!watchId) {
        reply.code(400).send({ error: "watchId is required" });
        return;
      }
      try {
        return cancelSelfMergeWatch(
          {
            sessionManager,
            ...(deps.mergeWatchManager ? { mergeWatchManager: deps.mergeWatchManager } : {}),
          },
          request.params.sessionId,
          watchId,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to cancel self merge-watch: ${getErrorMessage(err)}` });
      }
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/cohort",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      try {
        return resolveSessionCohort(
          sessionManager,
          deps.runnerRegistry,
          request.params.sessionId,
          childProjections,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to resolve session cohort: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{
    Params: { sessionId: string };
    Body: { body?: string; subject?: string; severity?: string; to?: string };
  }>(
    "/api/sessions/:sessionId/report",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const payload = request.body ?? {};
      try {
        const result = await deliverSessionReport(
          {
            sessionManager,
            runnerRegistry: deps.runnerRegistry,
            chatHistoryManager: deps.chatHistoryManager,
            defaultAgentId: deps.defaultAgentId,
            credentialsDir: deps.credentialsDir,
            credentialStore: deps.credentialStore,
            providerAccountManager: deps.providerAccountManager,
            containerManager: deps.containerManager,
          },
          request.params.sessionId,
          {
            body: payload.body ?? "",
            ...(payload.subject !== undefined ? { subject: payload.subject } : {}),
            ...(payload.severity !== undefined ? { severity: payload.severity } : {}),
            ...(payload.to !== undefined ? { to: payload.to } : {}),
          },
        );
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to deliver session report: ${getErrorMessage(err)}` });
      }
    },
  );
}
