import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { getHostOverview } from "./services/index.js";
import { getErrorMessage } from "./validation.js";

export async function registerHostRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
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
