import type { FastifyInstance, FastifyReply } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import {
  getShipitSourceStatus,
  listShipitSourceTree,
  searchShipitSource,
  catShipitSource,
  logShipitSource,
  blameShipitSource,
  showShipitSource,
  ServiceError,
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
    reply.code(403).send({ error: "ShipIt source access is only available in Ops sessions." });
    return false;
  }
  return true;
}

function sendError(reply: FastifyReply, err: unknown, fallback: string): void {
  if (err instanceof ServiceError) {
    reply.code(err.statusCode).send({ error: err.message });
    return;
  }
  reply.code(500).send({ error: `${fallback}: ${getErrorMessage(err)}` });
}

export async function registerSourceRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const { sessionManager } = deps;

  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/source/status",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      if (!requireOpsSession(sessionManager, request.params.id, reply)) return;
      try {
        return await getShipitSourceStatus();
      } catch (err) {
        sendError(reply, err, "Failed to read source status");
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/sessions/:id/source/tree",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      if (!requireOpsSession(sessionManager, request.params.id, reply)) return;
      try {
        return await listShipitSourceTree(request.query.path ?? "");
      } catch (err) {
        sendError(reply, err, "Failed to list source tree");
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { q?: string; path?: string } }>(
    "/api/sessions/:id/source/search",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      if (!requireOpsSession(sessionManager, request.params.id, reply)) return;
      try {
        return await searchShipitSource(request.query.q ?? "", request.query.path);
      } catch (err) {
        sendError(reply, err, "Failed to search source");
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/sessions/:id/source/cat",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      if (!requireOpsSession(sessionManager, request.params.id, reply)) return;
      try {
        return await catShipitSource(request.query.path ?? "");
      } catch (err) {
        sendError(reply, err, "Failed to read source file");
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { path?: string; limit?: string } }>(
    "/api/sessions/:id/source/log",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      if (!requireOpsSession(sessionManager, request.params.id, reply)) return;
      try {
        const limit = request.query.limit ? Number(request.query.limit) : undefined;
        return await logShipitSource(
          request.query.path,
          limit !== undefined && Number.isFinite(limit) ? { limit } : {},
        );
      } catch (err) {
        sendError(reply, err, "Failed to read source history");
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/sessions/:id/source/blame",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      if (!requireOpsSession(sessionManager, request.params.id, reply)) return;
      try {
        return await blameShipitSource(request.query.path ?? "");
      } catch (err) {
        sendError(reply, err, "Failed to blame source file");
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { commit?: string; path?: string } }>(
    "/api/sessions/:id/source/show",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      if (!requireOpsSession(sessionManager, request.params.id, reply)) return;
      try {
        return await showShipitSource(request.query.commit ?? "", request.query.path);
      } catch (err) {
        sendError(reply, err, "Failed to show source commit");
      }
    },
  );
}
