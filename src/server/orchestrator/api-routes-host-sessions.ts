import type { FastifyInstance, FastifyReply } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import {
  ServiceError,
  queryHostSessions,
  queryHostSessionLogs,
  type HostSessionQuery,
  type HostSessionLogQuery,
} from "./services/index.js";
import { getErrorMessage } from "./validation.js";
import type { SessionManager } from "./sessions.js";

function requireOpsSession(
  sessionManager: SessionManager,
  sessionId: string,
  reply: FastifyReply,
): boolean {
  const session = sessionManager.get(sessionId);
  if (!session) {
    reply.code(404).send({ error: "Session not found" });
    return false;
  }
  if (session.kind !== "ops") {
    reply.code(403).send({ error: "Host session inventory is only available in Ops sessions." });
    return false;
  }
  return true;
}

export async function registerHostSessionRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const { sessionManager } = deps;

  app.get<{
    Params: { id: string };
    Querystring: {
      branch?: string;
      pr?: string;
      container?: string;
      id?: string;
      includeArchived?: string;
      includeWarm?: string;
      limit?: string;
      offset?: string;
    };
  }>(
    "/api/sessions/:id/host-sessions",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      if (!requireOpsSession(sessionManager, request.params.id, reply)) return;
      try {
        const q = request.query;
        const query: HostSessionQuery = {};
        if (q.branch) query.branch = q.branch;
        if (q.container) query.container = q.container;
        if (q.id) query.id = q.id;
        if (q.pr) {
          const pr = Number(q.pr);
          if (!Number.isFinite(pr) || pr <= 0 || !Number.isInteger(pr)) {
            reply.code(400).send({ error: `Invalid pr number: ${q.pr}` });
            return;
          }
          query.pr = pr;
        }
        if (q.includeArchived === "true") query.includeArchived = true;
        if (q.includeWarm === "true") query.includeWarm = true;
        if (q.limit) {
          const limit = Number(q.limit);
          if (Number.isFinite(limit)) query.limit = limit;
        }
        if (q.offset) query.offset = Number(q.offset);
        return queryHostSessions(sessionManager, query);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply
          .code(500)
          .send({ error: `Failed to read host sessions: ${getErrorMessage(err)}` });
      }
    },
  );

  // :id identifies the caller for the container guard; target identifies the logs' owner.
  app.get<{
    Params: { id: string };
    Querystring: { target?: string; since?: string; until?: string; lines?: string };
  }>(
    "/api/sessions/:id/host-session-logs",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      if (!requireOpsSession(sessionManager, request.params.id, reply)) return;
      const { logStore } = deps;
      if (!logStore) {
        reply.code(503).send({ error: "The durable log store is not available on this host." });
        return;
      }
      try {
        const q = request.query;
        const query: HostSessionLogQuery = {};
        if (q.since) query.since = q.since;
        if (q.until) query.until = q.until;
        if (q.lines) query.lines = Number(q.lines);
        return queryHostSessionLogs(sessionManager, logStore, q.target ?? "", query);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply
          .code(500)
          .send({ error: `Failed to read session logs: ${getErrorMessage(err)}` });
      }
    },
  );
}
