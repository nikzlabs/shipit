/**
 * Issue tracker routes (docs/170 — inline tracker Issues tab; SHI-80).
 *
 * These are global `/api/...` routes, not `/api/sessions/:id/...`, because
 * Linear is deployment-wide. GitHub Issues, however, are **per-repo**, so the
 * read routes accept an optional `?sessionId` and resolve that session's GitHub
 * remote + token into a `GitHubTrackerContext` for the registry. Linear ignores
 * the session entirely (its binding is the workspace team). Read-only +
 * connect/bind for Linear; write-back and the GitHub `/shipit` push trigger
 * remain out of scope (SHI-43 / docs/156).
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
import type { GitHubTrackerContext } from "./trackers/index.js";
import { parseGitHubRemote } from "./git-utils.js";
import { getErrorMessage } from "./validation.js";

export async function registerIssueRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const { credentialStore, trackerFetchImpl, sessionManager, githubAuthManager } = deps;

  /**
   * Resolve the GitHub tracker context for a request: ShipIt's existing GitHub
   * token plus the repo derived from the active session's remote. Either piece
   * may be null (GitHub not connected, no active session, or a non-GitHub
   * remote) — the adapter then reports unconfigured.
   */
  function resolveGitHubContext(sessionId?: string): GitHubTrackerContext {
    const token = githubAuthManager.getToken();
    const remoteUrl = sessionId ? sessionManager.get(sessionId)?.remoteUrl : undefined;
    const parsed = remoteUrl ? parseGitHubRemote(remoteUrl) : null;
    return { token, repo: parsed ? { owner: parsed.owner, repo: parsed.repo } : null };
  }

  // GET /api/trackers — configured-tracker metadata (drives the sub-tabs).
  app.get<{ Querystring: { sessionId?: string } }>("/api/trackers", async (request) => {
    const github = resolveGitHubContext(request.query.sessionId);
    return { trackers: listTrackers(credentialStore, trackerFetchImpl, github) };
  });

  // GET /api/issues?tracker=linear[&includeDone=true][&sessionId=...] —
  // priority-sorted issue list for one tracker. `includeDone` widens the default
  // open working set to also include completed/"done" issues (canceled stays
  // excluded). `sessionId` scopes the GitHub tracker to that session's repo.
  app.get<{ Querystring: { tracker?: string; includeDone?: string; sessionId?: string } }>(
    "/api/issues",
    async (request, reply) => {
      const trackerId = request.query.tracker ?? "linear";
      const includeDone = request.query.includeDone === "true";
      const github = resolveGitHubContext(request.query.sessionId);
      try {
        return await listIssuesForTracker(credentialStore, trackerId, trackerFetchImpl, github, {
          includeDone,
        });
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to list issues: ${getErrorMessage(err)}` });
      }
    },
  );

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
