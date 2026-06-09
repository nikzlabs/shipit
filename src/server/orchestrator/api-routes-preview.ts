/**
 * Preview API routes.
 * Handles: preview status, preview restart, preview error reporting.
 */

import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";

import {
  validatePreviewError,
  ServiceError,
} from "./services/index.js";
import { getErrorMessage } from "./validation.js";
import { stripAnsi } from "../shared/strip-ansi.js";

export async function registerPreviewRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const { sessionManager } = deps;

  // GET /api/sessions/:id/preview-status — current preview state
  app.get<{ Params: { id: string } }>("/api/sessions/:id/preview-status", async (request, reply) => {
    const session = sessionManager.get(request.params.id);
    if (!session) {
      reply.code(404).send({ error: "Session not found" });
      return;
    }
    const runner = deps.runnerRegistry.get(request.params.id);
    if (!runner?.previewStatusKnown) {
      return { known: false };
    }
    const status = runner.buildPreviewStatus();
    return { known: true, ...status };
  });

  // GET /api/sessions/:id/services — list compose services with status
  app.get<{ Params: { id: string } }>("/api/sessions/:id/services", async (request, reply) => {
    const mgr = deps.serviceManagers?.get(request.params.id);
    if (!mgr) {
      reply.code(404).send({ error: "No compose stack for this session" });
      return;
    }
    return { services: mgr.getServices() };
  });

  // GET /api/sessions/:id/services/:name/logs — fetch service logs (ANSI stripped)
  app.get<{ Params: { id: string; name: string }; Querystring: { lines?: string } }>(
    "/api/sessions/:id/services/:name/logs",
    async (request, reply) => {
      const mgr = deps.serviceManagers?.get(request.params.id);
      if (!mgr) {
        reply.code(404).send({ error: "No compose stack for this session" });
        return;
      }
      const svc = mgr.getService(request.params.name);
      if (!svc) {
        reply.code(404).send({ error: `Unknown service: ${request.params.name}` });
        return;
      }
      // Snapshot fresh from Docker (see ServiceManager.snapshotLogs): the
      // in-memory ring buffer rotates and is wiped on reconcile, so it drops
      // history the caller expects to still be there.
      const lines = parseInt(request.query.lines ?? "", 10);
      const tail = Number.isFinite(lines) && lines > 0 ? lines : undefined;
      const logs = stripAnsi(await mgr.snapshotLogs(request.params.name, tail ?? 2000));
      return { name: request.params.name, logs };
    },
  );

  // POST /api/sessions/:id/preview-errors — report preview error
  app.post<{ Params: { id: string }; Body: { message: string; stack?: string } }>(
    "/api/sessions/:id/preview-errors",
    async (request, reply) => {
      try {
        const validated = validatePreviewError(request.body.message, request.body.stack);
        const parts = [validated.message];
        if (validated.stack) parts.push(validated.stack);
        const text = parts.join("\n");
        deps.broadcastLog(request.params.id, "preview", text);
        // Also emit to the session's runner so connected WS viewers receive it
        const runner = deps.runnerRegistry.get(request.params.id);
        if (runner) {
          runner.emitMessage({ type: "log_entry", source: "preview", text, timestamp: new Date().toISOString() });
        }
        reply.code(204).send();
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to report preview error: ${getErrorMessage(err)}` });
      }
    },
  );
}
