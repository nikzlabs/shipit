import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import {
  getSettingForAgent,
  listSettingsForAgent,
  ServiceError,
  type SettingsReadDeps,
} from "./services/index.js";
import { getErrorMessage } from "./validation.js";
import { proposeSettingChange } from "./services/settings-propose.js";
import { settingsProposalDeps } from "./services/settings-proposal-deps.js";
import type { SettingsOperationKind } from "./services/settings-operations.js";

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
    // So a read carries what the user last did about the setting (req 8).
    proposals: deps.settingsProposals,
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

  // The agent's only write path: it posts a card and returns its id. Nothing is
  // applied here — the user's click is (docs/299-agent-settings-access req 4).
  app.post<{
    Params: { id: string };
    Body: {
      key?: string;
      operation?: SettingsOperationKind;
      item?: string;
      value?: unknown;
      valueText?: string;
      reason?: string;
    };
  }>(
    "/api/sessions/:id/settings/propose",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const key = request.body?.key?.trim();
      if (!key) {
        reply.code(400).send({ error: "key is required" });
        return;
      }
      const proposeDeps = settingsProposalDeps(deps);
      if (!proposeDeps) {
        reply.code(503).send({ error: "This install cannot post settings proposals." });
        return;
      }
      try {
        const card = await proposeSettingChange(proposeDeps, request.params.id, {
          key,
          ...(request.body.operation ? { operation: request.body.operation } : {}),
          ...(request.body.item !== undefined ? { item: request.body.item } : {}),
          ...("value" in (request.body ?? {}) ? { value: request.body.value } : {}),
          ...(request.body.valueText !== undefined ? { valueText: request.body.valueText } : {}),
          ...(request.body.reason !== undefined ? { reason: request.body.reason } : {}),
        });
        return { card };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to propose a settings change: ${getErrorMessage(err)}` });
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
