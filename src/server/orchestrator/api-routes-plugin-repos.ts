/**
 * docs/262 — plugin repositories: the browser snapshot route behind the
 * Plugins tab (`plan.md` §3). Code namespace note: the marketplace skills
 * feature owns `/api/plugins/*` (docs/149), so this feature lives at
 * `/api/plugin-repos`.
 *
 * One authoritative GET, the `issues.trackers` precedent copied: the config is
 * read fresh per request (the file is committed — an edit must change the tab
 * on the next request without a restart), and the client refetches on the
 * `files_changed` shipit.yaml hook. Refresh/WS deltas arrive with the slice-2
 * generation mechanics.
 */

import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import {
  buildPluginReposSnapshot,
  EMPTY_PLUGIN_REPOS,
  type PluginReposSnapshot,
} from "../shared/plugin-repos.js";
import { getErrorMessage } from "./validation.js";

export async function registerPluginRepoRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  // GET /api/plugin-repos?sessionId — one snapshot: declaration, per-repo
  // cards, parse warnings, and the consuming project's remote (the secret
  // store "Add key…" must write to — plan §3).
  app.get<{ Querystring: { sessionId?: string } }>(
    "/api/plugin-repos",
    async (request) => {
      const session = request.query.sessionId
        ? deps.sessionManager.get(request.query.sessionId)
        : undefined;
      const consumerRepoUrl = session?.remoteUrl ?? null;

      // With no session there is no repository to have declared anything —
      // an empty answer, not an error (the issues-route precedent).
      if (!session?.workspaceDir) {
        return emptySnapshot(consumerRepoUrl);
      }

      try {
        const config = resolveShipitConfig(session.workspaceDir);
        return buildPluginReposSnapshot(
          config.plugins,
          config.pluginExports,
          consumerRepoUrl,
          config.warnings,
        );
      } catch (err) {
        // A malformed *document* (bad YAML, a bad `release` block) must not
        // break the tab for a problem elsewhere in the file — but the tab must
        // say the declarations were unreadable rather than "declares nothing"
        // (req 13: a broken declaration keeps its warning surface).
        const snapshot = emptySnapshot(consumerRepoUrl);
        return {
          ...snapshot,
          warnings: [
            `shipit.yaml could not be parsed, so no plugin declarations were read: ${getErrorMessage(err)}`,
          ],
        };
      }
    },
  );
}

function emptySnapshot(consumerRepoUrl: string | null): PluginReposSnapshot {
  return buildPluginReposSnapshot({ ...EMPTY_PLUGIN_REPOS }, [], consumerRepoUrl, []);
}
