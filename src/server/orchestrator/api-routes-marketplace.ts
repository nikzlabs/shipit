import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import type { MarketplaceStore } from "./marketplace-store.js";
import {
  ServiceError,
  ensureCatalogCloned,
  getCatalogCacheRoot,
  installPluginAsSession,
  listMarketplaces,
  listPlugins,
  readPluginSkillBody,
} from "./services/index.js";
import { getErrorMessage } from "./validation.js";
import { isHarnessInstalled } from "../shared/installed-harnesses.js";

export interface MarketplaceRouteDeps {
  marketplaceStore: MarketplaceStore;
  stateDir: string;
}

export async function registerMarketplaceRoutes(
  app: FastifyInstance,
  deps: ApiDeps & MarketplaceRouteDeps,
): Promise<void> {
  const { marketplaceStore, stateDir } = deps;
  const cacheRoot = getCatalogCacheRoot(stateDir);

  app.get<{ Querystring: { agent?: string } }>(
    "/api/marketplaces",
    async (request) => {
      const agent =
        request.query.agent === "codex" || request.query.agent === "claude"
        || request.query.agent === "opencode" || request.query.agent === "grok"
          ? request.query.agent
          : undefined;
      return { marketplaces: listMarketplaces(marketplaceStore, agent) };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/marketplaces/:id/plugins",
    async (request, reply) => {
      try {
        await ensureCatalogCloned(marketplaceStore, request.params.id, cacheRoot);
        const plugins = await listPlugins(marketplaceStore, request.params.id, cacheRoot);
        const info = marketplaceStore.get(request.params.id);
        return { plugins, marketplace: info };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/marketplaces/:id/refresh",
    async (request, reply) => {
      try {
        await ensureCatalogCloned(marketplaceStore, request.params.id, cacheRoot);
        return { marketplace: marketplaceStore.get(request.params.id) };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Body: { marketplaceId?: unknown; pluginName?: unknown; repoUrl?: unknown; agentId?: unknown } }>(
    "/api/plugins/install",
    async (request, reply) => {
      const marketplaceId = typeof request.body.marketplaceId === "string" ? request.body.marketplaceId : null;
      const pluginName = typeof request.body.pluginName === "string" ? request.body.pluginName : null;
      const repoUrl = typeof request.body.repoUrl === "string" ? request.body.repoUrl.trim() : null;
      const requestedAgentId = typeof request.body.agentId === "string" ? request.body.agentId : null;
      const installedAgents = deps.agentRegistry.list().filter((agent) => isHarnessInstalled(agent.id));
      const agentId = requestedAgentId
        ? installedAgents.find((agent) => agent.id === requestedAgentId)?.id ?? null
        : null;
      if (!marketplaceId || !pluginName || !repoUrl) {
        reply.code(400).send({ error: "marketplaceId, pluginName, and repoUrl are required" });
        return;
      }
      if (requestedAgentId !== null && !agentId) {
        reply.code(400).send({
          error: `agentId must be one of: ${installedAgents.map((agent) => agent.id).join(", ")}`,
        });
        return;
      }
      if (!deps.claimSessionService) {
        reply.code(503).send({ error: "Session creation is unavailable in this runtime." });
        return;
      }
      try {
        await ensureCatalogCloned(marketplaceStore, marketplaceId, cacheRoot);
        const result = await installPluginAsSession(
          {
            claimService: deps.claimSessionService,
            sessionManager: deps.sessionManager,
            runnerRegistry: deps.runnerRegistry,
            repoStore: deps.repoStore,
            createGitManager: deps.createGitManager,
            agentRegistry: deps.agentRegistry,
            marketplaceStore,
            cacheRoot,
            githubAuthManager: deps.githubAuthManager,
            sseBroadcast: deps.sseBroadcast,
            defaultAgentId: deps.defaultAgentId,
            ...(deps.prStatusPoller ? { prStatusPoller: deps.prStatusPoller } : {}),
            ...(deps.ensureAgentTokenFresh ? { ensureAgentTokenFresh: deps.ensureAgentTokenFresh } : {}),
          },
          { repoUrl, marketplaceId, pluginName, ...(agentId ? { agentId } : {}) },
        );
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: getErrorMessage(err) });
      }
    },
  );

  app.get<{ Params: { id: string; plugin: string; skill: string } }>(
    "/api/marketplaces/:id/plugins/:plugin/skills/:skill",
    async (request, reply) => {
      try {
        const body = await readPluginSkillBody(
          marketplaceStore,
          request.params.id,
          cacheRoot,
          request.params.plugin,
          request.params.skill,
        );
        return { content: body };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: (err as Error).message });
      }
    },
  );
}
