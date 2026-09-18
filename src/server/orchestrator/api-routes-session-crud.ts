import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { resolveSessionDir } from "./api-routes.js";

import {
  getSessionStatus,
  listAllSessions,
  unarchiveSession,
  renameSession,
  renameSessionByAgent,
  setSessionPinned,
  setKeepPreviewRunning,
  setSessionMuted,
  reorderSessionPins,
  archiveSession,
  applyTemplate,
  createSandboxSession,
  readSandboxCapabilities,
  updateSandboxCapabilities,
  forkSession,
  forkReportSinks,
  gitRemoteCredentialResolver,
  createHeadlessSession,
  ServiceError,
  createClaimSessionService,
} from "./services/index.js";
import type { AgentId, IssueRef } from "../shared/types.js";
import type { BillingMode } from "../shared/catalogue/index.js";
import { getErrorMessage } from "./validation.js";
import { markIssueStartedFromSeed } from "./issue-lifecycle.js";
import { dismissNonTurnFailure } from "./services/non-turn-work.js";
import { reconcileSessionEgress } from "./services/reconcile-session-egress.js";

export async function registerSessionCrudRoutes(
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

  app.get<{ Params: { id: string } }>("/api/sessions/:id/status", async (request, reply) => {
    const session = sessionManager.get(request.params.id);
    if (!session) {
      reply.code(404).send({ error: "Session not found" });
      return;
    }
    return {
      sessionId: request.params.id,
      ...getSessionStatus(deps.runnerRegistry, request.params.id),
    };
  });

  app.get("/api/sessions/all", async () => {
    return { sessions: listAllSessions(sessionManager) };
  });

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/unarchive",
    async (request, reply) => {
      try {
        const result = await unarchiveSession(
          sessionManager,
          createRepoGit,
          deps.getSharedRepoDir,
          deps.githubAuthManager,
          deps.repoStore,
          request.params.id,
          deps.prStatusPoller,
          createGitManager,
        );
        deps.sseBroadcast("session_list", { sessions: result.sessions });
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to unarchive session: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Params: { id: string; cardId: string } }>(
    "/api/sessions/:id/non-turn-failure/:cardId/dismiss",
    async (request, reply) => {
      if (!deps.chatHistoryManager) {
        reply.code(503).send({ error: "Chat history is unavailable" });
        return;
      }
      const dismissed = dismissNonTurnFailure(
        {
          getRunnerRegistry: () => deps.runnerRegistry,
          chatHistoryManager: deps.chatHistoryManager,
        },
        request.params.id,
        request.params.cardId,
      );
      if (!dismissed) {
        reply.code(404).send({ error: "No such notice in this session" });
        return;
      }
      return { dismissed: true };
    },
  );

  app.patch<{ Params: { id: string }; Body: { title: string } }>(
    "/api/sessions/:id",
    async (request, reply) => {
      try {
        const session = renameSession(sessionManager, request.params.id, request.body.title);
        deps.sseBroadcast("session_renamed", { session });
        return { session };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to rename session: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { title?: string } }>(
    "/api/sessions/:id/rename",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      try {
        return renameSessionByAgent(
          {
            sessionManager,
            runnerRegistry: deps.runnerRegistry,
            chatHistoryManager: deps.chatHistoryManager,
            sseBroadcast: deps.sseBroadcast,
          },
          request.params.id,
          request.body?.title,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to rename session: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/pin",
    async (request, reply) => {
      try {
        const { session, sessions } = setSessionPinned(sessionManager, request.params.id, true);
        deps.sseBroadcast("session_list", { sessions });
        return { session };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to pin session: ${getErrorMessage(err)}` });
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/sessions/:id/pin",
    async (request, reply) => {
      try {
        const { session, sessions } = setSessionPinned(sessionManager, request.params.id, false);
        deps.sseBroadcast("session_list", { sessions });
        return { session };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to unpin session: ${getErrorMessage(err)}` });
      }
    },
  );

  app.put<{ Params: { id: string }; Body: { enabled?: unknown } }>(
    "/api/sessions/:id/keep-preview-running",
    async (request, reply) => {
      try {
        if (typeof request.body?.enabled !== "boolean") {
          throw new ServiceError(400, "enabled must be a boolean");
        }
        const result = setKeepPreviewRunning(
          sessionManager,
          request.params.id,
          request.body.enabled,
          (session) => {
            if (!session.workspaceDir) throw new ServiceError(409, "Session has no workspace to preview");
            if (session.diskTier === "light") sessionManager.setDiskTier(session.id, "hot");
            deps.runnerRegistry.getOrCreate(
              session.id,
              session.workspaceDir,
              session.agentId ?? deps.defaultAgentId,
            );
          },
        );
        deps.sseBroadcast("session_list", { sessions: result.sessions });
        return { session: result.session };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to update preview reservation: ${getErrorMessage(err)}` });
      }
    },
  );

  app.put<{ Params: { id: string }; Body: { muted?: unknown } }>(
    "/api/sessions/:id/muted",
    async (request, reply) => {
      try {
        if (typeof request.body?.muted !== "boolean") {
          throw new ServiceError(400, "muted must be a boolean");
        }
        const runner = deps.runnerRegistry.get(request.params.id);
        const agentWorking = !!runner
          && (runner.running
            || runner.awaitingPermissionIds.size > 0
            || runner.backgroundWorkDescriptions.length > 0);
        const result = setSessionMuted(
          sessionManager,
          request.params.id,
          request.body.muted,
          agentWorking,
        );
        deps.sseBroadcast("session_list", { sessions: result.sessions });
        return { session: result.session };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to update session mute: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Body: { remoteUrl: string; ids: string[] } }>(
    "/api/sessions/pin-order",
    async (request, reply) => {
      try {
        const { remoteUrl, ids } = request.body;
        const { sessions } = reorderSessionPins(sessionManager, remoteUrl, ids);
        deps.sseBroadcast("session_list", { sessions });
        return { sessions };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to reorder pins: ${getErrorMessage(err)}` });
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/sessions/:id",
    async (request, reply) => {
      try {
        const result = await archiveSession(
          sessionManager,
          deps.runnerRegistry,
          deps.getSharedRepoDir,
          request.params.id,
          deps.pruneSessionVolumes,
          deps.containerManager,
          deps.removeSessionLogs,
          createGitManager,
        );
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to archive session: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { templateId: string; targetSessionId?: string } }>(
    "/api/sessions/:id/template",
    async (request, reply) => {
      try {
        const result = await applyTemplate(
          sessionManager, createGitManager, deps.createSessionDir,
          request.body.templateId, request.params.id === "new" ? undefined : request.params.id,
          request.body.targetSessionId,
        );
        return { templateId: result.templateId, name: result.name, session: result.session, seedPrompt: result.seedPrompt };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to apply template: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Body: { capabilities?: { git?: boolean; docker?: boolean; network?: boolean; dangerousGitHubOps?: boolean } } }>(
    "/api/sessions/sandbox",
    async (request, reply) => {
      try {
        const result = await createSandboxSession(
          sessionManager,
          deps.createSessionDir,
          request.body?.capabilities,
        );
        deps.sseBroadcast("session_list", { sessions: sessionManager.list() });
        return { session: result.session, capabilities: result.capabilities };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to create sandbox session: ${getErrorMessage(err)}` });
      }
    },
  );

  // Keep capability updates browser-only so containers cannot grant themselves access.
  const sessionSettingsDeps = () => ({
    sessionManager,
    runnerRegistry: deps.runnerRegistry,
    chatHistoryManager: deps.chatHistoryManager,
    ...(deps.containerManager ? { containerManager: deps.containerManager } : {}),
    sseBroadcast: deps.sseBroadcast,
  });

  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/capabilities",
    async (request, reply) => {
      try {
        return readSandboxCapabilities(sessionSettingsDeps(), request.params.id);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to read capabilities: ${getErrorMessage(err)}` });
      }
    },
  );

  app.put<{ Params: { id: string }; Body: { capabilities?: unknown } }>(
    "/api/sessions/:id/capabilities",
    async (request, reply) => {
      try {
        return updateSandboxCapabilities(
          sessionSettingsDeps(),
          request.params.id,
          request.body?.capabilities,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to update capabilities: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { branchName: string; startPoint?: string } }>(
    "/api/sessions/:id/fork",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const result = await forkSession(
          sessionManager, createRepoGit, deps.getSharedRepoDir, deps.sessionsRoot,
          deps.githubAuthManager, { init: () => {} },
          request.params.id, dir,
          request.body.branchName, request.body.startPoint, undefined,
          graduationDeps,
          gitRemoteCredentialResolver(deps.githubAuthManager),
          forkReportSinks({ sessionManager, sseBroadcast: deps.sseBroadcast }),
        );
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to fork session: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{
    Body: {
      repoUrl?: string;
      initialPrompt?: string;
      agent?: AgentId;
      model?: string;
      reasoning?: string;
      issueRef?: IssueRef;
      armAutoMerge?: boolean;
      serviceId?: string;
      billingMode?: BillingMode;
      role?: string;
      dictated?: boolean;
      /** true: contained; false: open; null or absent: inherit. */
      networkMode?: boolean | null;
    };
  }>(
    "/api/sessions/headless",
    async (request, reply) => {
      let repoUrl = "";
      let initialPrompt = "";
      let agent: AgentId | undefined;
      let model: string | undefined;
      let serviceId: string | undefined;
      let billingMode: BillingMode | undefined;
      let reasoning: string | undefined;
      let role: string | undefined;
      let issueRef: IssueRef | undefined;
      let armAutoMerge = false;
      let dictated = false;
      let networkMode: boolean | null | undefined;
      const uploadInputs: { filename: string; data: Buffer }[] = [];

      if (request.isMultipart()) {
        try {
          for await (const part of request.parts()) {
            if (part.type === "file") {
              const buf = await part.toBuffer();
              uploadInputs.push({ filename: part.filename, data: buf });
              continue;
            }
            const value = typeof part.value === "string" ? part.value : "";
            switch (part.fieldname) {
              case "repoUrl":
                repoUrl = value;
                break;
              case "initialPrompt":
                initialPrompt = value;
                break;
              case "agent":
                agent = value as AgentId;
                break;
              case "model":
                model = value;
                break;
              case "serviceId":
                serviceId = value;
                break;
              case "billingMode":
                if (value === "sub" || value === "key") billingMode = value;
                break;
              case "reasoning":
                reasoning = value;
                break;
              case "role":
                role = value;
                break;
              case "armAutoMerge":
                armAutoMerge = value === "true";
                break;
              case "dictated":
                dictated = value === "true";
                break;
              case "networkMode":
                if (value === "true") networkMode = true;
                else if (value === "false") networkMode = false;
                break;
              default:
                break;
            }
          }
        } catch (err) {
          reply.code(400).send({ error: `Invalid multipart body: ${getErrorMessage(err)}` });
          return;
        }
      } else {
        const body = request.body ?? {};
        repoUrl = body.repoUrl ?? "";
        initialPrompt = body.initialPrompt ?? "";
        agent = body.agent;
        model = body.model;
        serviceId = body.serviceId;
        billingMode = body.billingMode;
        reasoning = body.reasoning;
        role = body.role;
        issueRef = body.issueRef;
        if (body.armAutoMerge !== undefined && typeof body.armAutoMerge !== "boolean") {
          reply.code(400).send({ error: "armAutoMerge must be a boolean" });
          return;
        }
        armAutoMerge = body.armAutoMerge === true;
        if (body.dictated !== undefined && typeof body.dictated !== "boolean") {
          reply.code(400).send({ error: "dictated must be a boolean" });
          return;
        }
        dictated = body.dictated === true;
        if (
          body.networkMode !== undefined
          && body.networkMode !== null
          && typeof body.networkMode !== "boolean"
        ) {
          reply.code(400).send({ error: "networkMode must be true, false, or null" });
          return;
        }
        networkMode = body.networkMode;
      }

      try {
        const result = await createHeadlessSession(
          sessionManager,
          deps.runnerRegistry,
          claimSessionService,
          {
            repoUrl,
            prompt: initialPrompt,
            ...(issueRef !== undefined ? { issueRef } : {}),
            ...(agent !== undefined ? { agent } : {}),
            ...(model !== undefined ? { model } : {}),
            ...(serviceId !== undefined ? { serviceId } : {}),
            ...(billingMode !== undefined ? { billingMode } : {}),
            ...(reasoning !== undefined ? { reasoning } : {}),
            ...(role !== undefined && role !== "" ? { role } : {}),
            ...(uploadInputs.length > 0 ? { uploads: uploadInputs } : {}),
            armAutoMerge,
            ...(dictated ? { dictated: true } : {}),
            ...(networkMode !== undefined ? { networkMode } : {}),
          },
          deps.defaultAgentId,
          deps.credentialsDir,
          deps.credentialStore,
          deps.providerAccountManager,
          graduationDeps,
          {
            githubAuthManager: deps.githubAuthManager,
            prStatusPoller: deps.prStatusPoller,
          },
          deps.egressAllowlistStore
            ? {
                store: deps.egressAllowlistStore,
                reconcile: (sid, reconcileOpts) => reconcileSessionEgress(
                  {
                    containerManager: deps.containerManager ?? null,
                    egressAllowlistStore: deps.egressAllowlistStore,
                    ...(deps.oomBreaker ? { oomBreaker: deps.oomBreaker } : {}),
                    recovery: {
                      sessionManager,
                      containerManager: deps.containerManager ?? null,
                      runnerRegistry: deps.runnerRegistry,
                      defaultAgentId: deps.defaultAgentId,
                      ...(deps.oomBreaker ? { oomBreaker: deps.oomBreaker } : {}),
                      ...(deps.loopDetector ? { loopDetector: deps.loopDetector } : {}),
                      sseBroadcast: deps.sseBroadcast,
                    },
                  },
                  sid,
                  reconcileOpts ?? {},
                ),
              }
            : undefined,
        );
        if (issueRef && deps.credentialStore && deps.chatHistoryManager) {
          const lifecycleDeps = {
            credentialStore: deps.credentialStore,
            ...(deps.trackerFetchImpl ? { trackerFetchImpl: deps.trackerFetchImpl } : {}),
            githubAuthManager: deps.githubAuthManager,
            sessionManager,
            chatHistoryManager: deps.chatHistoryManager,
            runnerRegistry: deps.runnerRegistry,
          };
          void markIssueStartedFromSeed(lifecycleDeps, result.sessionId, issueRef).catch(
            (err: unknown) => {
              console.warn("[api-routes-session] seed 'started' failed:", err);
            },
          );
        }

        return {
          sessionId: result.sessionId,
          branch: result.branch,
          status: "running" as const,
          session: result.session,
        };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Couldn't start a session — try again: ${getErrorMessage(err)}` });
      }
    },
  );
}
