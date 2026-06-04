/**
 * Issue tracker routes (docs/170 — inline tracker Issues tab).
 *
 * Repo/workspace-scoped (NOT session-scoped): a Linear workspace is
 * deployment-wide, so these are global `/api/...` routes, not
 * `/api/sessions/:id/...`. v1 is read-only + connect/bind for Linear; the
 * GitHub adapter and any write-back are deferred (SHI-67 scope).
 */

import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import {
  listTrackers,
  listIssuesForTracker,
  connectLinear,
  getLinearTeams,
  setLinearTeam,
  disconnectLinear,
  ServiceError,
} from "./services/index.js";
import { getErrorMessage } from "./validation.js";

export async function registerIssueRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const { credentialStore, trackerFetchImpl } = deps;

  // GET /api/trackers — configured-tracker metadata (drives the sub-tabs).
  app.get("/api/trackers", async () => {
    return { trackers: listTrackers(credentialStore, trackerFetchImpl) };
  });

  // GET /api/issues?tracker=linear[&includeDone=true] — priority-sorted issue
  // list for one tracker. `includeDone` widens the default open working set to
  // also include completed/"done" issues (canceled stays excluded).
  app.get<{ Querystring: { tracker?: string; includeDone?: string } }>("/api/issues", async (request, reply) => {
    const trackerId = request.query.tracker ?? "linear";
    const includeDone = request.query.includeDone === "true";
    try {
      return await listIssuesForTracker(credentialStore, trackerId, trackerFetchImpl, { includeDone });
    } catch (err) {
      if (err instanceof ServiceError) {
        reply.code(err.statusCode).send({ error: err.message });
        return;
      }
      reply.code(500).send({ error: `Failed to list issues: ${getErrorMessage(err)}` });
    }
  });

  // ---- Linear connect / binding (settings) ----

  // POST /api/trackers/linear/token — validate + store a Linear API token.
  app.post<{ Body: { token?: string } }>("/api/trackers/linear/token", async (request, reply) => {
    try {
      return await connectLinear(credentialStore, request.body?.token ?? "", trackerFetchImpl);
    } catch (err) {
      if (err instanceof ServiceError) {
        reply.code(err.statusCode).send({ error: err.message });
        return;
      }
      reply.code(500).send({ error: `Failed to connect Linear: ${getErrorMessage(err)}` });
    }
  });

  // GET /api/trackers/linear/teams — list workspace teams for the team picker.
  app.get("/api/trackers/linear/teams", async (_request, reply) => {
    try {
      return { teams: await getLinearTeams(credentialStore, trackerFetchImpl) };
    } catch (err) {
      if (err instanceof ServiceError) {
        reply.code(err.statusCode).send({ error: err.message });
        return;
      }
      reply.code(500).send({ error: `Failed to list Linear teams: ${getErrorMessage(err)}` });
    }
  });

  // POST /api/trackers/linear/team — bind the Issues tab to a team.
  app.post<{ Body: { id?: string; key?: string; name?: string } }>(
    "/api/trackers/linear/team",
    async (request, reply) => {
      try {
        return { tracker: setLinearTeam(credentialStore, request.body) };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to bind Linear team: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/trackers/linear/disconnect — clear token + team binding.
  app.post("/api/trackers/linear/disconnect", async () => {
    disconnectLinear(credentialStore);
    return { ok: true };
  });
}
