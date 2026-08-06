/**
 * docs/255 — read-only host session INVENTORY for Ops sessions.
 *
 *   GET /api/sessions/:id/host-sessions[?branch=&pr=&container=&id=
 *                                        &includeArchived=&limit=]
 *
 * Answers "which session produced this branch / PR / container?" from the
 * orchestrator's own `sessions` table, so an Ops session no longer has to
 * correlate journal timestamps against container names and guess.
 *
 * Deliberately shaped exactly like `api-routes-source.ts` (docs/162), for the
 * same reason: it is an Ops-only read that coexists with the container trust
 * boundary WITHOUT weakening it.
 *
 *  - The route lives under the CALLER'S OWN session path, so
 *    `api-container-guard.ts`'s §3 own-session scope check passes unchanged —
 *    no cross-session exemption, no `HARD_DENY_PREFIXES` edit, and
 *    `/api/sessions` itself stays container-inaccessible.
 *  - `config: { containerAccessible: true }` + `requireOpsSession()` on the
 *    server-authoritative `session.kind === "ops"` (404 absent, 403 non-ops).
 *  - The worker injects the trusted SESSION_ID, so the agent cannot ask on
 *    another session's behalf.
 *
 * The response is METADATA ONLY — id/title/kind/branch/repo/parent/timestamps
 * and the PR number+url+state. Never conversation replay, prompts, queued
 * messages, assistant text, secrets, env, or workspace contents. The allowlist
 * that enforces that is `services/host-sessions.ts:buildHostSessionView`; read
 * its docstring before adding a field here.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { ServiceError, queryHostSessions, type HostSessionQuery } from "./services/index.js";
import { getErrorMessage } from "./validation.js";
import type { SessionManager } from "./sessions.js";

/**
 * Confirm the calling session exists and is an Ops session. Sends the 404/403
 * itself and returns false so the route can bail. Mirrors the identical gate in
 * `api-routes-source.ts` — Ops is the only kind allowed to read across sessions.
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

  // GET /api/sessions/:id/host-sessions[?filters]
  //
  // NOTE on the `id=` filter name: the container guard falls back to a
  // `?session=` query param for its own-session scope check when a path carries
  // no `/api/sessions/<id>/` segment. This route HAS that segment, so `session=`
  // would never be consulted here — but naming a filter the same thing the guard
  // reads as a scope is a trap for whoever touches either file next. Hence `id=`.
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
        if (q.offset) {
          const offset = Number(q.offset);
          if (Number.isFinite(offset)) query.offset = offset;
        }
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
}
