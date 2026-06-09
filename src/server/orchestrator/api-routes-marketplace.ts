/**
 * Marketplace HTTP routes (docs/149 — skill install UX).
 *
 * App-wide routes for browsing pre-seeded marketplace catalogs and previewing
 * a plugin's SKILL.md before install. Session-scoped install/uninstall verbs
 * live in `api-routes-files.ts` alongside the existing
 * `GET /api/sessions/:id/skills` from doc 138.
 */

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
import type { AgentId } from "../shared/types.js";

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

  // GET /api/marketplaces?agent=claude — list the catalogs the user can browse.
  app.get<{ Querystring: { agent?: string } }>(
    "/api/marketplaces",
    async (request) => {
      const agent = request.query.agent === "codex" || request.query.agent === "claude"
        ? (request.query.agent as AgentId)
        : undefined;
      return { marketplaces: listMarketplaces(marketplaceStore, agent) };
    },
  );

  // GET /api/marketplaces/:id/plugins — list installable plugins from a catalog.
  // Triggers a lazy fetch if the cache is missing (e.g. the startup pre-clone
  // hasn't completed yet, or it previously failed and the user clicked Retry).
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

  // POST /api/marketplaces/:id/refresh — user-initiated re-clone / pull.
  // Same operation the startup pre-clone runs, exposed for the Retry button
  // on the Discover tab's per-marketplace fetch-failed state.
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

  // POST /api/plugins/install — repo-targeted install (docs/149 v1c).
  //
  // App-wide, NOT session-scoped: the user explicitly picks a repo, and the
  // install runs in its own freshly-spawned session on a new branch and opens a
  // PR. The current session (if any) is never touched. The session-scoped
  // `POST /api/sessions/:id/plugins/install` route is retained in
  // api-routes-files.ts for the future "install into this workspace" option.
  app.post<{ Body: { marketplaceId?: unknown; pluginName?: unknown; repoUrl?: unknown } }>(
    "/api/plugins/install",
    async (request, reply) => {
      const marketplaceId = typeof request.body.marketplaceId === "string" ? request.body.marketplaceId : null;
      const pluginName = typeof request.body.pluginName === "string" ? request.body.pluginName : null;
      const repoUrl = typeof request.body.repoUrl === "string" ? request.body.repoUrl.trim() : null;
      if (!marketplaceId || !pluginName || !repoUrl) {
        reply.code(400).send({ error: "marketplaceId, pluginName, and repoUrl are required" });
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
          { repoUrl, marketplaceId, pluginName },
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

  // GET /api/marketplaces/:id/plugins/:plugin/skills/:skill — Monaco preview body.
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
