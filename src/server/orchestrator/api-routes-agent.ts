import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import type {
  PermissionMode,
  ImageAttachment,
  FileContextRef,
  UploadRef,
  AgentId,
} from "../shared/types.js";
import {
  dispatchAgentMessage,
  materializeRunner,
  runSubAgent,
  deliverConsultResultByWake,
  parseSubAgentSpawnTarget,
  getSubAgentResult,
  waitForSubAgentResult,
  listRolesForAgent,
  listSpawnParameters,
  DEFAULT_SUB_AGENT_WAIT_MS,
  MAX_SUB_AGENT_WAIT_MS,
  ServiceError,
} from "./services/index.js";
import { getErrorMessage } from "./validation.js";
import { AgentTurnAdmissionError } from "./session-runner.js";
import type { AgentInterfaceProvenance } from "../shared/agent-interface-sdk/protocol.js";

export async function registerAgentRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  app.post<{
    Params: { id: string };
    Body: {
      text?: string;
      agentInterface?: AgentInterfaceProvenance;
      activity?: string;
      permissionMode?: PermissionMode;
      images?: ImageAttachment[];
      files?: FileContextRef[];
      uploads?: UploadRef[];
    };
  }>(
    "/api/sessions/:id/agent/dispatch",
    async (request, reply) => {
      try {
        const body = request.body ?? {};
        const result = await dispatchAgentMessage(
          {
            runnerRegistry: deps.runnerRegistry,
            agentRegistry: deps.agentRegistry,
            ...(deps.ensureAgentTokenFresh ? { ensureAgentTokenFresh: deps.ensureAgentTokenFresh } : {}),
            credentialStore: deps.credentialStore,
            authManager: deps.authManager,
            sessionManager: deps.sessionManager,
            graduation: {
              repoStore: deps.repoStore,
              createGitManager: deps.createGitManager,
              sseBroadcast: deps.sseBroadcast,
              ...(deps.prStatusPoller ? { prStatusPoller: deps.prStatusPoller } : {}),
              ...(deps.ensureAgentTokenFresh ? { ensureAgentTokenFresh: deps.ensureAgentTokenFresh } : {}),
            },
            ...(deps.warmSessionForRepo ? { warmSessionForRepo: deps.warmSessionForRepo } : {}),
            wakeSession: (sessionId) => materializeRunner(
              {
                sessionManager: deps.sessionManager,
                runnerRegistry: deps.runnerRegistry,
                createRepoGit: deps.createRepoGit,
                getBareCacheDir: deps.getSharedRepoDir,
                githubAuthManager: deps.githubAuthManager,
                repoStore: deps.repoStore,
              },
              sessionId,
              deps.defaultAgentId,
            ),
          },
          request.params.id,
          {
            text: body.text ?? "",
            ...(body.agentInterface !== undefined ? { agentInterface: body.agentInterface } : {}),
            ...(body.activity !== undefined ? { activity: body.activity } : {}),
            ...(body.permissionMode !== undefined ? { permissionMode: body.permissionMode } : {}),
            ...(body.images !== undefined ? { images: body.images } : {}),
            ...(body.files !== undefined ? { files: body.files } : {}),
            ...(body.uploads !== undefined ? { uploads: body.uploads } : {}),
          },
        );
        reply.send(result);
      } catch (err) {
        if (err instanceof AgentTurnAdmissionError) {
          reply.code(err.statusCode).send({ error: err.message, code: err.code, sessionId: err.sessionId });
          return;
        }
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Dispatch failed: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      prompt?: string;
      depth?: number;
      role?: string;
      agentId?: AgentId;
      serviceId?: string;
      billingMode?: string;
      modelId?: string;
      reasoningEffort?: string;
    };
  }>(
    "/api/sessions/:id/agent/spawn",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      try {
        const body = request.body ?? {};
        const target = parseSubAgentSpawnTarget(body);
        const result = await runSubAgent(
          {
            sessionManager: deps.sessionManager,
            credentialStore: deps.credentialStore,
            agentRegistry: deps.agentRegistry,
            ...(deps.providerAccountManager ? { providerAccountManager: deps.providerAccountManager } : {}),
            runnerRegistry: deps.runnerRegistry,
            usageManager: deps.usageManager,
            chatHistoryManager: deps.chatHistoryManager,
            ...(deps.recordAgentRateLimits ? { recordAgentRateLimits: deps.recordAgentRateLimits } : {}),
            ...(deps.credentialsDir ? { credentialsDir: deps.credentialsDir } : {}),
            createGitManager: deps.createGitManager,
            // A background consult can finish after the parent CLI has exited.
            deliverConsultResult: (req) =>
              deliverConsultResultByWake(
                {
                  sessionManager: deps.sessionManager,
                  runnerRegistry: deps.runnerRegistry,
                  chatHistoryManager: deps.chatHistoryManager,
                  defaultAgentId: deps.defaultAgentId,
                  credentialsDir: deps.credentialsDir,
                  credentialStore: deps.credentialStore,
                  providerAccountManager: deps.providerAccountManager,
                  containerManager: deps.containerManager,
                },
                req,
              ),
          },
          request.params.id,
          {
            target,
            prompt: body.prompt ?? "",
            depth: typeof body.depth === "number" ? body.depth : 0,
          },
        );
        reply.send(result);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Sub-agent spawn failed: ${getErrorMessage(err)}` });
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/agent/roles",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const session = deps.sessionManager.get(request.params.id);
      if (!session) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      reply.send({
        roles: listRolesForAgent({
          credentialStore: deps.credentialStore,
          ...(deps.providerAccountManager ? { providerAccountManager: deps.providerAccountManager } : {}),
        }),
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/agent/params",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const session = deps.sessionManager.get(request.params.id);
      if (!session) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      reply.send(listSpawnParameters(deps.agentRegistry));
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { spawnId?: string; wait?: string; timeout?: string; segment?: string };
  }>(
    "/api/sessions/:id/agent/result",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      try {
        const spawnId = request.query.spawnId?.trim();
        if (request.query.wait === "true") {
          const requestedTimeoutSecs = Number(request.query.timeout);
          const timeoutMs = Number.isFinite(requestedTimeoutSecs) && requestedTimeoutSecs > 0
            ? Math.min(Math.floor(requestedTimeoutSecs * 1000), MAX_SUB_AGENT_WAIT_MS)
            : DEFAULT_SUB_AGENT_WAIT_MS;
          const requestedSegmentSecs = Number(request.query.segment);
          const segmentMs = Number.isFinite(requestedSegmentSecs) && requestedSegmentSecs > 0
            ? Math.min(Math.floor(requestedSegmentSecs * 1000), timeoutMs)
            : timeoutMs;
          const result = await waitForSubAgentResult(
            { chatHistoryManager: deps.chatHistoryManager },
            request.params.id,
            { ...(spawnId ? { spawnId } : {}), segmentMs },
          );
          reply.send({ ...result.card, outcome: result.outcome });
          return;
        }
        const card = getSubAgentResult(
          { chatHistoryManager: deps.chatHistoryManager },
          request.params.id,
          spawnId || undefined,
        );
        reply.send(card);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Sub-agent result lookup failed: ${getErrorMessage(err)}` });
      }
    },
  );
}
