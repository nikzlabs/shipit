import type { FastifyInstance } from "fastify";
import type { SecretStore } from "./secret-store.js";
import type { SessionManager } from "./sessions.js";
import type { ServiceManager } from "./service-manager.js";
import { getErrorMessage } from "./validation.js";

export interface SecretsDeps {
  secretStore: SecretStore;
  sessionManager: SessionManager;
  serviceManagers: Map<string, ServiceManager>;
}

export async function registerSecretsRoutes(
  app: FastifyInstance,
  deps: SecretsDeps,
): Promise<void> {
  const { secretStore, sessionManager, serviceManagers } = deps;

  // Return names only; existing secret values must not reach the browser.
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

      for (const [key, value] of Object.entries(set ?? {})) {
        if (typeof key !== "string" || typeof value !== "string") {
          return reply.code(400).send({ error: "All secret keys and values must be strings" });
        }
      }
      for (const key of keep ?? []) {
        if (typeof key !== "string") {
          return reply.code(400).send({ error: "All keep entries must be strings" });
        }
      }

      const existing = secretStore.loadSecrets(repoUrl);
      const secrets: Record<string, string> = {};
      for (const key of keep ?? []) {
        if (key in existing) secrets[key] = existing[key];
      }
      for (const [key, value] of Object.entries(set ?? {})) {
        secrets[key] = value;
      }

      secretStore.saveSecrets(repoUrl, secrets);

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
