/**
 * Container recovery API routes — health probe, recovery actions, and the
 * full diagnostics payload.
 *
 * See docs/112-container-recovery/plan.md and
 * docs/124-session-rescue-and-diagnostics/plan.md. Four endpoints:
 *
 *   GET  /api/sessions/:id/container/health         — aggregated health strip
 *   GET  /api/sessions/:id/diagnostics              — full debug payload (124 §3)
 *   POST /api/sessions/:id/agent/kill               — SIGKILL the agent
 *   POST /api/sessions/:id/container/restart        — destroy + recreate (Rescue session)
 *   POST /api/sessions/:id/agent/container/restart  — destroy + recreate agent only (127)
 *
 * These are HTTP rather than WebSocket because they need to work even
 * when the per-session WS or the worker itself is in a degraded state,
 * and HTTP gives a clean ACK.
 */

import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import type { ServiceManager } from "./service-manager.js";

import {
  getContainerHealth,
  getSessionDiagnostics,
  killAgent,
  restartAgent,
  restartContainer,
  ServiceError,
} from "./services/index.js";
import { getErrorMessage } from "./validation.js";

export async function registerContainerRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const { sessionManager } = deps;

  // GET /api/sessions/:id/container/health — diagnostics for the health strip
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/container/health",
    async (request, reply) => {
      const session = sessionManager.get(request.params.id);
      if (!session) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      try {
        return await getContainerHealth(
          {
            containerManager: deps.containerManager ?? null,
            runnerRegistry: deps.runnerRegistry,
          },
          request.params.id,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to read container health: ${getErrorMessage(err)}` });
      }
    },
  );

  // GET /api/sessions/:id/diagnostics — full debug payload (Session diagnostics panel + bug reports)
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/diagnostics",
    async (request, reply) => {
      const session = sessionManager.get(request.params.id);
      if (!session) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      try {
        return await getSessionDiagnostics(
          {
            containerManager: deps.containerManager ?? null,
            runnerRegistry: deps.runnerRegistry,
            serviceManagers: deps.serviceManagers ?? new Map<string, ServiceManager>(),
            getLogBuffer: deps.getLogBuffer ?? (() => []),
            getWorkspaceDir: (id) => sessionManager.get(id)?.workspaceDir ?? null,
            ...(deps.oomBreaker ? { oomBreaker: deps.oomBreaker } : {}),
          },
          request.params.id,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to read diagnostics: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/:id/agent/kill — force-kill the agent (SIGKILL)
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/agent/kill",
    async (request, reply) => {
      try {
        const result = await killAgent(
          {
            sessionManager: deps.sessionManager,
            containerManager: deps.containerManager ?? null,
            runnerRegistry: deps.runnerRegistry,
            defaultAgentId: deps.defaultAgentId,
          },
          request.params.id,
        );
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to kill agent: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/:id/container/restart — destroy + recreate container
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/container/restart",
    async (request, reply) => {
      try {
        const result = await restartContainer(
          {
            sessionManager: deps.sessionManager,
            containerManager: deps.containerManager ?? null,
            runnerRegistry: deps.runnerRegistry,
            defaultAgentId: deps.defaultAgentId,
            ...(deps.oomBreaker ? { oomBreaker: deps.oomBreaker } : {}),
          },
          request.params.id,
        );
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to restart container: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/:id/agent/container/restart — destroy + recreate JUST the
  // agent container; leave the compose stack running. Lighter-weight than the
  // full Rescue session. See docs/127-restart-agent.
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/agent/container/restart",
    async (request, reply) => {
      try {
        const result = await restartAgent(
          {
            sessionManager: deps.sessionManager,
            containerManager: deps.containerManager ?? null,
            runnerRegistry: deps.runnerRegistry,
            defaultAgentId: deps.defaultAgentId,
            ...(deps.oomBreaker ? { oomBreaker: deps.oomBreaker } : {}),
          },
          request.params.id,
        );
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to restart agent: ${getErrorMessage(err)}` });
      }
    },
  );
}
