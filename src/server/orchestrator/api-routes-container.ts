// Recovery must remain available when the session WebSocket or worker fails.

import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import type { ServiceManager } from "./service-manager.js";

import {
  getContainerHealth,
  getSessionDiagnostics,
  killAgent,
  restartAgent,
  restartContainer,
  ServiceError,
} from "./services/index.js";
import { getErrorMessage } from "./validation.js";
import { accountServiceForHarness } from "./provider-account-manager.js";

export async function registerContainerRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const { sessionManager } = deps;

  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/container/health",
    async (request, reply) => {
      const session = sessionManager.get(request.params.id);
      if (!session) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      try {
        return await getContainerHealth(
          {
            containerManager: deps.containerManager ?? null,
            runnerRegistry: deps.runnerRegistry,
          },
          request.params.id,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to read container health: ${getErrorMessage(err)}` });
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/diagnostics",
    async (request, reply) => {
      const session = sessionManager.get(request.params.id);
      if (!session) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      try {
        return await getSessionDiagnostics(
          {
            containerManager: deps.containerManager ?? null,
            runnerRegistry: deps.runnerRegistry,
            serviceManagers: deps.serviceManagers ?? new Map<string, ServiceManager>(),
            getLogBuffer: deps.getLogBuffer ?? (() => []),
            getWorkspaceDir: (id) => sessionManager.get(id)?.workspaceDir ?? null,
            getSessionRoute: (id) => sessionManager.get(id),
            getAccountLabel: (provider, accountId) =>
              deps.providerAccountManager.get(accountServiceForHarness(provider), accountId)?.label,
            ...(deps.oomBreaker ? { oomBreaker: deps.oomBreaker } : {}),
          },
          request.params.id,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to read diagnostics: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/agent/kill",
    async (request, reply) => {
      try {
        const result = await killAgent(
          {
            sessionManager: deps.sessionManager,
            containerManager: deps.containerManager ?? null,
            runnerRegistry: deps.runnerRegistry,
            defaultAgentId: deps.defaultAgentId,
            ...(deps.prStatusPoller
              ? {
                  postInterruptCommitDeps: {
                    sessionManager: deps.sessionManager,
                    chatHistoryManager: deps.chatHistoryManager,
                    prStatusPoller: deps.prStatusPoller,
                    githubAuthManager: deps.githubAuthManager,
                    credentialStore: deps.credentialStore,
                    generateText: deps.generateText,
                    createGitManager: deps.createGitManager,
                  },
                }
              : {}),
          },
          request.params.id,
        );
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to kill agent: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/container/restart",
    async (request, reply) => {
      try {
        const result = await restartContainer(
          {
            sessionManager: deps.sessionManager,
            containerManager: deps.containerManager ?? null,
            runnerRegistry: deps.runnerRegistry,
            defaultAgentId: deps.defaultAgentId,
            ...(deps.oomBreaker ? { oomBreaker: deps.oomBreaker } : {}),
            ...(deps.loopDetector ? { loopDetector: deps.loopDetector } : {}),
            sseBroadcast: deps.sseBroadcast,
          },
          request.params.id,
        );
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to restart container: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/agent/container/restart",
    async (request, reply) => {
      try {
        const result = await restartAgent(
          {
            sessionManager: deps.sessionManager,
            containerManager: deps.containerManager ?? null,
            runnerRegistry: deps.runnerRegistry,
            defaultAgentId: deps.defaultAgentId,
            ...(deps.oomBreaker ? { oomBreaker: deps.oomBreaker } : {}),
            ...(deps.loopDetector ? { loopDetector: deps.loopDetector } : {}),
          },
          request.params.id,
        );
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to restart agent: ${getErrorMessage(err)}` });
      }
    },
  );
}
