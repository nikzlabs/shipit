/**
 * Secrets API routes.
 * Handles: loading and saving per-repo environment variable secrets.
 *
 * Secrets are stored in the orchestrator's SQLite database (SecretStore),
 * keyed by repo URL.
 */

import type { FastifyInstance } from "fastify";
import type { SecretStore } from "./secret-store.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { SessionManager } from "./sessions.js";

export interface SecretsDeps {
  secretStore: SecretStore;
  runnerRegistry: SessionRunnerRegistry;
  sessionManager: SessionManager;
}

export async function registerSecretsRoutes(
  app: FastifyInstance,
  deps: SecretsDeps,
): Promise<void> {
  const { secretStore } = deps;

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

      // Save to database
      secretStore.saveSecrets(repoUrl, secrets);

      // TODO: Push secrets to compose services via .shipit/.env
      return { saved: true };
    },
  );
}
