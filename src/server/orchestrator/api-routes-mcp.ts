/**
 * MCP server API routes (docs/088-mcp-integration).
 *
 * Account-level CRUD for user-configured MCP servers, plus a connectivity
 * test that is proxied into an active session container (the orchestrator
 * never execs user-supplied stdio binaries itself — see plan §"Test endpoint
 * isolation").
 *
 * Server config blobs hold `$secret:` placeholders only; raw secret values
 * live in `CredentialStore.agentEnv` under `mcp__<server>__*` and are never
 * echoed back. After every mutation we trigger the agent-env refresh path on
 * each active session's ServiceManager so the merged `.shipit/.env.agent` is
 * rewritten and pushed to the worker (reusing 087's transport substrate).
 */

import type { FastifyInstance } from "fastify";
import type { CredentialStore } from "./credential-store.js";
import type { ServiceManager } from "./service-manager.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import {
  ServiceError,
  listMcpServers,
  addMcpServer,
  updateMcpServer,
  removeMcpServer,
} from "./services/index.js";
import { getErrorMessage } from "./validation.js";

export interface McpRoutesDeps {
  credentialStore: CredentialStore;
  runnerRegistry: SessionRunnerRegistry;
  /** Per-session ServiceManager registry — used to push refreshed agent env. */
  serviceManagers: Map<string, ServiceManager>;
}

/** A runner that can proxy an MCP test into its container. */
interface McpTestCapableRunner {
  proxyMcpTest(config: unknown): Promise<unknown>;
}

function isMcpTestCapable(runner: unknown): runner is McpTestCapableRunner {
  return (
    !!runner &&
    typeof (runner as McpTestCapableRunner).proxyMcpTest === "function"
  );
}

/**
 * Trigger the agent-env refresh on every active session's ServiceManager.
 * Each `refreshSecrets()` re-runs `syncSecrets()`, which re-reads the
 * `mcp__*` keys from CredentialStore, rewrites `.shipit/.env.agent`, and
 * pushes the full set to the worker via `PUT /secrets`. The worker REPLACES
 * its tracked set on every push, so deleted/renamed keys are dropped without
 * an explicit clear list. Fire-and-forget per session.
 */
function refreshAgentEnvForAllSessions(serviceManagers: Map<string, ServiceManager>): void {
  for (const [sessionId, mgr] of serviceManagers) {
    mgr.refreshSecrets().catch((err: unknown) => {
      console.warn(`[mcp] agent-env refresh failed for session ${sessionId}:`, getErrorMessage(err));
    });
  }
}

export async function registerMcpRoutes(
  app: FastifyInstance,
  deps: McpRoutesDeps,
): Promise<void> {
  const { credentialStore, runnerRegistry, serviceManagers } = deps;

  // GET /api/mcp-servers — list all configured servers (placeholder form).
  app.get("/api/mcp-servers", async () => {
    return { servers: listMcpServers(credentialStore) };
  });

  // POST /api/mcp-servers — add a new server.
  app.post<{ Body: { config?: unknown; secrets?: unknown } }>(
    "/api/mcp-servers",
    async (request, reply) => {
      const { config, secrets } = request.body ?? {};
      try {
        const saved = addMcpServer(credentialStore, config, secrets);
        refreshAgentEnvForAllSessions(serviceManagers);
        return { server: saved };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode);
          return { error: err.message };
        }
        throw err;
      }
    },
  );

  // PUT /api/mcp-servers/:id — update (or rename) a server.
  app.put<{ Params: { id: string }; Body: { config?: unknown; secrets?: unknown } }>(
    "/api/mcp-servers/:id",
    async (request, reply) => {
      const { config, secrets } = request.body ?? {};
      try {
        const { config: saved } = updateMcpServer(
          credentialStore,
          request.params.id,
          config,
          secrets,
        );
        refreshAgentEnvForAllSessions(serviceManagers);
        return { server: saved };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode);
          return { error: err.message };
        }
        throw err;
      }
    },
  );

  // DELETE /api/mcp-servers/:id — remove a server and its secrets.
  app.delete<{ Params: { id: string } }>(
    "/api/mcp-servers/:id",
    async (request, reply) => {
      try {
        removeMcpServer(credentialStore, request.params.id);
        refreshAgentEnvForAllSessions(serviceManagers);
        return { deleted: true };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode);
          return { error: err.message };
        }
        throw err;
      }
    },
  );

  // POST /api/mcp-servers/:id/test — connectivity test, proxied into a
  // session container. 409 if no active container exists.
  app.post<{ Params: { id: string } }>(
    "/api/mcp-servers/:id/test",
    async (request, reply) => {
      const server = credentialStore.getMcpServer(request.params.id);
      if (!server) {
        reply.code(404);
        return { error: `MCP server "${request.params.id}" not found` };
      }

      // Find any session runner that can proxy the test into its container.
      let runner: McpTestCapableRunner | undefined;
      for (const id of runnerRegistry.ids()) {
        const candidate = runnerRegistry.get(id);
        if (isMcpTestCapable(candidate)) {
          runner = candidate;
          break;
        }
      }
      if (!runner) {
        reply.code(409);
        return {
          error: "No active session container. Start a session first to test MCP servers.",
        };
      }

      try {
        return await runner.proxyMcpTest(server);
      } catch (err) {
        return { ok: false, error: getErrorMessage(err) };
      }
    },
  );
}
