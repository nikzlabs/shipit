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
  listMarketplaces,
  listPlugins,
  readPluginSkillBody,
} from "./services/index.js";
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
