/**
 * Secrets API routes.
 * Handles: loading and saving per-repo environment variable secrets.
 *
 * Secrets are stored in the orchestrator's SQLite database (SecretStore),
 * keyed by repo URL. On save, they are pushed to the active preview
 * container(s) for sessions using that repo via PUT /secrets on each
 * preview worker.
 */

import type { FastifyInstance } from "fastify";
import type { SecretStore } from "./secret-store.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { SessionManager } from "./sessions.js";
import type { ContainerSessionRunner } from "./container-session-runner.js";

export interface SecretsDeps {
  secretStore: SecretStore;
  runnerRegistry: SessionRunnerRegistry;
  sessionManager: SessionManager;
}

export async function registerSecretsRoutes(
  app: FastifyInstance,
  deps: SecretsDeps,
): Promise<void> {
  const { secretStore, runnerRegistry, sessionManager } = deps;

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

      // Push to active preview containers for sessions using this repo
      const pushErrors: string[] = [];
      for (const session of sessionManager.list()) {
        if (session.remoteUrl !== repoUrl) continue;
        const runner = runnerRegistry.get(session.id);
        if (!runner?.supportsRemoteTerminal) continue;
        try {
          const containerRunner = runner as ContainerSessionRunner;
          await containerRunner.pushSecretsToPreview(secrets);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          pushErrors.push(`${session.id}: ${msg}`);
        }
      }

      if (pushErrors.length > 0) {
        return { saved: true, pushErrors };
      }
      return { saved: true };
    },
  );
}
