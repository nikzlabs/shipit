/**
 * docs/162 — read-only ShipIt source surface for Ops remediation sessions.
 *
 *   GET /api/sessions/:id/source/status            — running source ref + exactness
 *   GET /api/sessions/:id/source/tree[?path=...]   — list a directory at that ref
 *   GET /api/sessions/:id/source/search?q=...       — git grep at that ref
 *   GET /api/sessions/:id/source/cat?path=...        — read a file at that ref
 *   GET /api/sessions/:id/source/log[?path=&limit=] — commit history at that ref
 *   GET /api/sessions/:id/source/blame?path=...      — line attribution at that ref
 *   GET /api/sessions/:id/source/show?commit=[&path=] — a commit's metadata + diff
 *
 * Every route is gated on the server-authoritative `session.kind === "ops"`
 * (the same gate that controls the privileged Docker/journal access in
 * container-lifecycle.ts) — a non-ops session that brokers to these routes
 * gets a 403. The worker injects the trusted SESSION_ID, so the agent can't
 * ask for source on behalf of a different session.
 *
 * All reads are brokered through `services/shipit-source.ts`, which serves a
 * concrete git ref with credentials/env/.git redacted. There are no write
 * routes here by design.
 */

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

/**
 * Confirm the calling session exists and is an Ops session. Sends the 404/403
 * itself and returns false so the route can bail. Ops is the only kind allowed
 * to read the host's ShipIt source.
 */
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

/** Map a thrown error to a Fastify reply, honoring ServiceError status codes. */
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

  // GET /api/sessions/:id/source/status
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/source/status",
    async (request, reply) => {
      if (!requireOpsSession(sessionManager, request.params.id, reply)) return;
      try {
        return await getShipitSourceStatus();
      } catch (err) {
        sendError(reply, err, "Failed to read source status");
      }
    },
  );

  // GET /api/sessions/:id/source/tree[?path=...]
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/sessions/:id/source/tree",
    async (request, reply) => {
      if (!requireOpsSession(sessionManager, request.params.id, reply)) return;
      try {
        return await listShipitSourceTree(request.query.path ?? "");
      } catch (err) {
        sendError(reply, err, "Failed to list source tree");
      }
    },
  );

  // GET /api/sessions/:id/source/search?q=...[&path=...]
  app.get<{ Params: { id: string }; Querystring: { q?: string; path?: string } }>(
    "/api/sessions/:id/source/search",
    async (request, reply) => {
      if (!requireOpsSession(sessionManager, request.params.id, reply)) return;
      try {
        return await searchShipitSource(request.query.q ?? "", request.query.path);
      } catch (err) {
        sendError(reply, err, "Failed to search source");
      }
    },
  );

  // GET /api/sessions/:id/source/cat?path=...
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/sessions/:id/source/cat",
    async (request, reply) => {
      if (!requireOpsSession(sessionManager, request.params.id, reply)) return;
      try {
        return await catShipitSource(request.query.path ?? "");
      } catch (err) {
        sendError(reply, err, "Failed to read source file");
      }
    },
  );

  // GET /api/sessions/:id/source/log[?path=...&limit=N]
  app.get<{ Params: { id: string }; Querystring: { path?: string; limit?: string } }>(
    "/api/sessions/:id/source/log",
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

  // GET /api/sessions/:id/source/blame?path=...
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/sessions/:id/source/blame",
    async (request, reply) => {
      if (!requireOpsSession(sessionManager, request.params.id, reply)) return;
      try {
        return await blameShipitSource(request.query.path ?? "");
      } catch (err) {
        sendError(reply, err, "Failed to blame source file");
      }
    },
  );

  // GET /api/sessions/:id/source/show?commit=...[&path=...]
  app.get<{ Params: { id: string }; Querystring: { commit?: string; path?: string } }>(
    "/api/sessions/:id/source/show",
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
