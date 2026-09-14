import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import {
  getSettingForAgent,
  listSettingsForAgent,
  ServiceError,
  type SettingsReadDeps,
} from "./services/index.js";
import { getErrorMessage } from "./validation.js";

// The agent's read of ShipIt's own settings (docs/299-agent-settings-access req 1).
// Session-scoped so the container guard's caller comparison applies: a container
// reaches these only for the session it belongs to.

export async function registerAgentSettingsRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const readDeps = (): SettingsReadDeps => ({
    agentRegistry: deps.agentRegistry,
    appWorkspaceDir: deps.workspaceDir,
    sessionManager: deps.sessionManager,
    credentialStore: deps.credentialStore,
    providerAccountManager: deps.providerAccountManager,
    egressAllowlistStore: deps.egressAllowlistStore,
    repoStore: deps.repoStore,
    secretStore: deps.secretStore,
    egressEnforcementStatus: deps.egressEnforcementStatus,
    egressEnforcementActive: deps.egressEnforcementActive,
    containerManager: deps.containerManager,
  });

  app.get<{ Params: { id: string }; Querystring: { tab?: string } }>(
    "/api/sessions/:id/settings",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      try {
        const tab = request.query.tab?.trim();
        return await listSettingsForAgent(
          readDeps(),
          request.params.id,
          tab ? { tab } : {},
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to list settings: ${getErrorMessage(err)}` });
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { key?: string } }>(
    "/api/sessions/:id/settings/detail",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const key = request.query.key?.trim();
      if (!key) {
        reply.code(400).send({ error: "key is required" });
        return;
      }
      try {
        return await getSettingForAgent(readDeps(), request.params.id, key);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to read setting: ${getErrorMessage(err)}` });
      }
    },
  );
}
