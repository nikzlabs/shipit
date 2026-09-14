import type { FastifyInstance } from "fastify";
import { requestRestart, requestUpdate } from "./services/updates.js";
import { applyReleaseChannel } from "./services/settings-apply.js";
import type { SettingsBroadcastDeps } from "./services/settings-apply.js";
import {
  checkUpdatesAndRecord,
  dismissUpdateNotice,
  invalidateUpdateResult,
  versionAnchor,
  type UpdateNoticeDeps,
} from "./services/update-notice.js";
import type { CredentialStore } from "./credential-store.js";
import type { UpdateNotice, VersionInfo } from "../shared/types.js";
import { ServiceError } from "./services/types.js";
import { getErrorMessage } from "./validation.js";

export interface UpdateRoutesDeps extends SettingsBroadcastDeps {
  credentialStore: CredentialStore;
  version?: VersionInfo;
}

export function updateNoticeDeps(deps: UpdateRoutesDeps): UpdateNoticeDeps {
  return {
    store: deps.credentialStore,
    anchor: versionAnchor(deps.version),
    broadcast: (notice: UpdateNotice | null) => deps.sseBroadcast("update_notice", notice),
  };
}

export async function registerUpdateRoutes(app: FastifyInstance, deps: UpdateRoutesDeps): Promise<void> {
  app.post("/api/updates/check", async (_request, reply) => {
    try {
      // Records the day's check and refreshes the banner, so a manual check and
      // the daily one are the same act (docs/304).
      return await checkUpdatesAndRecord(updateNoticeDeps(deps));
    } catch (err) {
      if (err instanceof ServiceError) {
        reply.code(err.statusCode).send({ error: err.message });
        return;
      }
      reply.code(500).send({ error: `Failed to check for updates: ${getErrorMessage(err)}` });
    }
  });

  app.post("/api/updates/dismiss", async (_request, reply) => {
    try {
      return { notice: dismissUpdateNotice(updateNoticeDeps(deps)) };
    } catch (err) {
      reply.code(500).send({ error: `Failed to dismiss update notice: ${getErrorMessage(err)}` });
    }
  });

  app.post<{ Body: { channel?: unknown } }>("/api/updates/channel", async (request, reply) => {
    const channel = request.body?.channel;
    if (channel !== "stable" && channel !== "edge") {
      reply.code(400).send({ error: "channel must be 'stable' or 'edge'" });
      return;
    }
    try {
      // The old channel's answer is dropped before the switch, not after it: a
      // write or check that then fails leaves viewers told nothing is known —
      // which the next check repairs — rather than showing the other channel's
      // update as if it were this one's (docs/304).
      const noticeDeps = updateNoticeDeps(deps);
      invalidateUpdateResult(noticeDeps);
      const { status, outcome } = await applyReleaseChannel(deps, channel);
      if (outcome.status !== "applied") {
        reply.code(500).send({ error: outcome.detail ?? "Failed to set channel", outcome });
        return;
      }
      // That write ran its own check under the new channel; record it rather
      // than paying for a second fetch.
      await checkUpdatesAndRecord({ ...noticeDeps, checkUpdates: () => Promise.resolve(status) });
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
