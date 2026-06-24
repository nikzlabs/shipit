/**
 * Secrets API routes.
 * Handles: listing the names of per-repo environment variable secrets and
 * saving new/changed values. Secret *values* are never sent to the browser —
 * GET returns key names only; PUT takes the values the user typed plus the
 * names of values to keep (resolved against stored values server-side).
 *
 * Secrets are stored in the orchestrator's SQLite database (SecretStore),
 * keyed by repo URL. After a save, the orchestrator rewrites
 * `.shipit/.env.<service>` files for every active session backed by that
 * repo and runs `docker compose up -d` so compose recreates the affected
 * containers with the new env values.
 */

import type { FastifyInstance } from "fastify";
import type { SecretStore } from "./secret-store.js";
import type { SessionManager } from "./sessions.js";
import type { ServiceManager } from "./service-manager.js";
import { getErrorMessage } from "./validation.js";

export interface SecretsDeps {
  secretStore: SecretStore;
  sessionManager: SessionManager;
  /**
   * Per-session ServiceManager registry (compose stacks). Used after a save
   * to push the new env to every active session for the repo.
   */
  serviceManagers: Map<string, ServiceManager>;
}

export async function registerSecretsRoutes(
  app: FastifyInstance,
  deps: SecretsDeps,
): Promise<void> {
  const { secretStore, sessionManager, serviceManagers } = deps;

  // GET /api/secrets?repoUrl=... — load the *names* of secrets set for a repo.
  //
  // SECURITY: this never returns secret values. The browser only needs to know
  // which keys have a stored value (to render "saved" state and custom rows);
  // exposing the plaintext would leak it to every viewer who opens project
  // settings. Values stay in the orchestrator and are resolved into env files
  // server-side. To change a value the user overwrites it; to keep it they send
  // the key back in `keep` (see PUT below).
  app.get<{ Querystring: { repoUrl?: string } }>(
    "/api/secrets",
    async (request, reply) => {
      const repoUrl = request.query.repoUrl;
      if (!repoUrl || typeof repoUrl !== "string") {
        return reply.code(400).send({ error: "repoUrl query parameter is required" });
      }
      const keys = secretStore.loadSecretNames(repoUrl);
      return { keys };
    },
  );

  // PUT /api/secrets — save secrets and push to active preview containers.
  //
  // Because the browser never receives existing values, it can't send a full
  // replacement map. Instead it sends `set` (keys with new/changed values it
  // typed) and `keep` (existing keys to preserve as-is, resolved against the
  // stored values here). The final state is `keep`'s stored values overlaid
  // with `set`; any existing key in neither list is dropped (deletion).
  app.put<{ Body: { repoUrl: string; set?: Record<string, string>; keep?: string[] } }>(
    "/api/secrets",
    async (request, reply) => {
      const { repoUrl, set, keep } = request.body ?? {};
      if (!repoUrl || typeof repoUrl !== "string") {
        return reply.code(400).send({ error: "repoUrl is required" });
      }
      if (set !== undefined && (typeof set !== "object" || set === null)) {
        return reply.code(400).send({ error: "set must be an object" });
      }
      if (keep !== undefined && !Array.isArray(keep)) {
        return reply.code(400).send({ error: "keep must be an array" });
      }

      // Validate all set keys and values are strings.
      for (const [key, value] of Object.entries(set ?? {})) {
        if (typeof key !== "string" || typeof value !== "string") {
          return reply.code(400).send({ error: "All secret keys and values must be strings" });
        }
      }
      // Validate all keep entries are strings.
      for (const key of keep ?? []) {
        if (typeof key !== "string") {
          return reply.code(400).send({ error: "All keep entries must be strings" });
        }
      }

      // Resolve `keep` against the stored values (server-side only) and overlay
      // the newly-typed `set` values, then full-replace so dropped keys don't
      // linger.
      const existing = secretStore.loadSecrets(repoUrl);
      const secrets: Record<string, string> = {};
      for (const key of keep ?? []) {
        if (key in existing) secrets[key] = existing[key];
      }
      for (const [key, value] of Object.entries(set ?? {})) {
        secrets[key] = value;
      }

      // Save to database first — the source of truth.
      secretStore.saveSecrets(repoUrl, secrets);

      // Push secrets to every active session backed by this repo. Each
      // session's ServiceManager rewrites its per-service `.shipit/.env.<svc>`
      // files and runs `docker compose up -d` so compose recreates containers
      // whose env file content changed. Fire-and-forget per session — a failure
      // in one session shouldn't block the API response or the others.
      const sessions = sessionManager.findAllByRemoteUrl(repoUrl);
      for (const session of sessions) {
        const mgr = serviceManagers.get(session.id);
        if (!mgr) continue;
        mgr.refreshSecrets().catch((err: unknown) => {
          console.warn(
            `[secrets] refresh failed for session ${session.id}:`,
            getErrorMessage(err),
          );
        });
      }

      return { saved: true };
    },
  );
}
