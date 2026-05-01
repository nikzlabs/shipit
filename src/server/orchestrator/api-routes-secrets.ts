/**
 * Secrets API routes.
 * Handles: loading and saving per-repo environment variable secrets.
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

  // GET /api/secrets?repoUrl=... — load secrets for a repo
  app.get<{ Querystring: { repoUrl?: string } }>(
    "/api/secrets",
    async (request, reply) => {
      const repoUrl = request.query.repoUrl;
      if (!repoUrl || typeof repoUrl !== "string") {
        return reply.code(400).send({ error: "repoUrl query parameter is required" });
      }
      const secrets = secretStore.loadSecrets(repoUrl);
      return { secrets };
    },
  );

  // PUT /api/secrets — save secrets and push to active preview containers
  app.put<{ Body: { repoUrl: string; secrets: Record<string, string> } }>(
    "/api/secrets",
    async (request, reply) => {
      const { repoUrl, secrets } = request.body ?? {};
      if (!repoUrl || typeof repoUrl !== "string") {
        return reply.code(400).send({ error: "repoUrl is required" });
      }
      if (!secrets || typeof secrets !== "object") {
        return reply.code(400).send({ error: "secrets must be an object" });
      }

      // Validate all keys and values are strings
      for (const [key, value] of Object.entries(secrets)) {
        if (typeof key !== "string" || typeof value !== "string") {
          return reply.code(400).send({ error: "All secret keys and values must be strings" });
        }
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
