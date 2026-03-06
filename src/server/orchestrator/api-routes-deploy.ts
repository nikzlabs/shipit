/**
 * Deployment API routes.
 * Handles: deploy history, deploy setup, deploy config save/delete.
 */

import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";

import {
  getDeployHistory,
  getDeploySetup,
  saveDeployConfig,
  deleteDeployConfig,
  ServiceError,
} from "./services/index.js";
import { getErrorMessage } from "./validation.js";

export async function registerDeployRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const { sessionManager } = deps;

  // GET /api/sessions/:id/deploy/history — deployment history
  app.get<{ Params: { id: string } }>("/api/sessions/:id/deploy/history", async (request, reply) => {
    const session = sessionManager.get(request.params.id);
    if (!session) {
      reply.code(404).send({ error: "Session not found" });
      return;
    }
    return { deployments: getDeployHistory(deps.deploymentStore, request.params.id) };
  });

  // GET /api/sessions/:id/deploy/setup — deploy targets + project settings (combined)
  app.get<{ Params: { id: string } }>("/api/sessions/:id/deploy/setup", async (request, reply) => {
    const session = sessionManager.get(request.params.id);
    if (!session) {
      reply.code(404).send({ error: "Session not found" });
      return;
    }
    return getDeploySetup(deps.deploymentManager, deps.deploymentStore, request.params.id);
  });

  // POST /api/sessions/:id/deploy/config — save deploy configuration
  app.post<{ Params: { id: string }; Body: { targetId: string; credentials: Record<string, string>; projectName?: string } }>(
    "/api/sessions/:id/deploy/config",
    async (request, reply) => {
      try {
        return saveDeployConfig(
          deps.deploymentManager, deps.deploymentStore, request.params.id,
          request.body.targetId, request.body.credentials, request.body.projectName,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to save deploy config: ${getErrorMessage(err)}` });
      }
    },
  );

  // DELETE /api/sessions/:id/deploy/config/:targetId — delete deploy configuration
  app.delete<{ Params: { id: string; targetId: string } }>(
    "/api/sessions/:id/deploy/config/:targetId",
    async (request, reply) => {
      const session = sessionManager.get(request.params.id);
      if (!session) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      return deleteDeployConfig(deps.deploymentStore, request.params.id, request.params.targetId);
    },
  );
}
