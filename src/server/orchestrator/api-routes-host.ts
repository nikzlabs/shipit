/**
 * docs/128 — host overview API for the ops session's read-only Host tab.
 *
 *   GET /api/host/overview — ShipIt-managed containers with status + session
 *                            correlation + live agent state.
 *
 * Read-only by construction: it only enumerates Docker state the orchestrator
 * already holds. No mutating host endpoints live here — actions go through the
 * agent in chat (§5).
 */

import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { getHostOverview } from "./services/index.js";
import { getErrorMessage } from "./validation.js";

export async function registerHostRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  // GET /api/host/overview — read-only host/Docker snapshot for the Host tab.
  app.get("/api/host/overview", async (_request, reply) => {
    try {
      return await getHostOverview({
        docker: deps.containerManager?.getDockerClient() ?? null,
        sessionManager: deps.sessionManager,
        runnerRegistry: deps.runnerRegistry,
      });
    } catch (err) {
      reply.code(500).send({ error: `Failed to read host overview: ${getErrorMessage(err)}` });
    }
  });
}
