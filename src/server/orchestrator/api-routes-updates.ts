/**
 * HTTP routes for self-update — check for updates and trigger host-side update.
 */

import type { FastifyInstance } from "fastify";
import { checkForUpdates, requestRestart, requestUpdate } from "./services/updates.js";
import { ServiceError } from "./services/types.js";
import { getErrorMessage } from "./validation.js";

export async function registerUpdateRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/updates/check — fetch from upstream and compare
  app.post("/api/updates/check", async (_request, reply) => {
    try {
      return await checkForUpdates();
    } catch (err) {
      if (err instanceof ServiceError) {
        reply.code(err.statusCode).send({ error: err.message });
        return;
      }
      reply.code(500).send({ error: `Failed to check for updates: ${getErrorMessage(err)}` });
    }
  });

  // POST /api/updates/apply — write trigger file for host-side updater
  app.post("/api/updates/apply", async (_request, reply) => {
    try {
      await requestUpdate();
      return { status: "update_requested" };
    } catch (err) {
      if (err instanceof ServiceError) {
        reply.code(err.statusCode).send({ error: err.message });
        return;
      }
      reply.code(500).send({ error: `Failed to apply update: ${getErrorMessage(err)}` });
    }
  });

  // POST /api/updates/restart — restart without pulling updates
  app.post("/api/updates/restart", async (_request, reply) => {
    try {
      await requestRestart();
      return { status: "restart_requested" };
    } catch (err) {
      if (err instanceof ServiceError) {
        reply.code(err.statusCode).send({ error: err.message });
        return;
      }
      reply.code(500).send({ error: `Failed to request restart: ${getErrorMessage(err)}` });
    }
  });
}
