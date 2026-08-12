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

import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import type { SessionManager } from "./sessions.js";
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

      // "Not yet knowable" is not "declares nothing" (review finding, and the
      // exact bug docs/248 hit with trackers): an evicted or mid-restore
      // checkout would otherwise cache an empty answer and cost the session
      // its Plugins tab until the next shipit.yaml event.
      if (areDeclarationsPending(deps.sessionManager, request.query.sessionId)) {
        return { ...emptySnapshot(consumerRepoUrl), pending: true };
      }

      // `resolveShipitConfig` collapses every read failure to an empty config,
      // so a file that exists but cannot be read would report "declares
      // nothing" with no warning at all — req 13 wants the surface (review
      // finding). Only an unreadable EXISTING file is a problem; an absent one
      // genuinely declares nothing.
      const configPath = path.join(session.workspaceDir, "shipit.yaml");
      if (fs.existsSync(configPath)) {
        try {
          fs.accessSync(configPath, fs.constants.R_OK);
        } catch (err) {
          return {
            ...emptySnapshot(consumerRepoUrl),
            warnings: [
              `shipit.yaml exists but could not be read, so no plugin declarations were loaded: ${getErrorMessage(err)}`,
            ],
          };
        }
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

/**
 * Whether "what does this repository declare?" is *not yet knowable* — the
 * same test `api-routes-issues.ts` runs for tracker declarations, and for the
 * same reason: `resolveShipitConfig` degrades a missing checkout to an empty
 * config, so pending and "declares nothing" are otherwise indistinguishable.
 *
 * The authoritative signal is the disk tier, not the directory existing:
 * `git clone` creates the target directory long before `shipit.yaml` lands, so
 * a client retrying on `existsSync` would stop on the first retry and cache
 * the empty answer anyway. `light` keeps its checkout and is not pending; a
 * session with no workspace declares nothing, permanently.
 */
function areDeclarationsPending(
  sessionManager: SessionManager,
  sessionId: string | undefined,
): boolean {
  const session = sessionId ? sessionManager.get(sessionId) : undefined;
  if (!session?.workspaceDir) return false;
  return session.diskTier === "evicted" || !fs.existsSync(session.workspaceDir);
}
