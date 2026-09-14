import type { FastifyInstance } from "fastify";
import { checkForUpdates, requestRestart, requestUpdate } from "./services/updates.js";
import { applyReleaseChannel } from "./services/settings-apply.js";
import type { SettingsBroadcastDeps } from "./services/settings-apply.js";
import { ServiceError } from "./services/types.js";
import { getErrorMessage } from "./validation.js";

export type UpdateRoutesDeps = SettingsBroadcastDeps;

export async function registerUpdateRoutes(app: FastifyInstance, deps: UpdateRoutesDeps): Promise<void> {
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

  app.post<{ Body: { channel?: unknown } }>("/api/updates/channel", async (request, reply) => {
    const channel = request.body?.channel;
    if (channel !== "stable" && channel !== "edge") {
      reply.code(400).send({ error: "channel must be 'stable' or 'edge'" });
      return;
    }
    try {
      const { status, outcome } = await applyReleaseChannel(deps, channel);
      // `setChannel` writes the channel and then checks for updates, which can
      // throw after the write landed — so a failure there is `uncertain`, not a
      // channel that stayed where it was.
      if (status === null) {
        reply.code(500).send({ error: outcome.detail ?? "Failed to set channel", outcome });
        return;
      }
      return status;
    } catch (err) {
      if (err instanceof ServiceError) {
        reply.code(err.statusCode).send({ error: err.message });
        return;
      }
      reply.code(500).send({ error: `Failed to set channel: ${getErrorMessage(err)}` });
    }
  });

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
