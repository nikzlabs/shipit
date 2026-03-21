/**
 * Bootstrap and global settings API routes.
 * Handles: GET /bootstrap, settings, auth, utility model, reset.
 */

import type { FastifyInstance } from "fastify";
import type { AgentId } from "../shared/types.js";
import type { ApiDeps } from "./api-routes.js";

import {
  getBootstrapData,
  setGitIdentityService,
  saveGlobalSettings,
  setAgent,
  setAgentEnv,
  setApiKey,
  clearApiKey,
  setUtilityModel,
  clearUtilityModel,
  fullReset,
  startAuth,
  submitAuthCode,
  ServiceError,
} from "./services/index.js";
import { getErrorMessage } from "./validation.js";

export async function registerBootstrapRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  // ---- GET /api/bootstrap ----
  app.get("/api/bootstrap", async () => {
    return getBootstrapData(deps);
  });

  // ---- Settings mutations ----

  // POST /api/settings/git-identity — set git identity (global)
  app.post<{ Body: { name: string; email: string } }>(
    "/api/settings/git-identity",
    async (request, reply) => {
      try {
        return setGitIdentityService(request.body.name, request.body.email);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to set git identity: ${getErrorMessage(err)}` });
      }
    },
  );

  // PUT /api/settings — save global settings
  app.put<{ Body: { gitIdentity?: { name: string; email: string }; systemPrompt?: string; maxIdleContainers?: number; agentSystemInstructionsEnabled?: boolean } }>(
    "/api/settings",
    async (request, reply) => {
      try {
        return await saveGlobalSettings(
          deps.agentRegistry, deps.defaultAgentId, deps.workspaceDir, deps.credentialStore,
          request.body.gitIdentity, request.body.systemPrompt, request.body.maxIdleContainers,
          request.body.agentSystemInstructionsEnabled,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to save settings: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/settings/agent — set active agent
  app.post<{ Body: { agentId: AgentId } }>(
    "/api/settings/agent",
    async (request, reply) => {
      try {
        return setAgent(deps.agentRegistry, request.body.agentId);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to set agent: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/agents/:id/env — set agent environment variable
  app.post<{ Params: { id: string }; Body: { key: string; value: string } }>(
    "/api/agents/:id/env",
    async (request, reply) => {
      try {
        const result = setAgentEnv(
          deps.agentRegistry, deps.credentialStore,
          request.params.id as AgentId, request.body.key, request.body.value,
        );
        return { agentId: result.agentId, key: result.key, success: true, agents: result.agents, defaultAgentId: deps.defaultAgentId };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to set agent env: ${getErrorMessage(err)}` });
      }
    },
  );

  // ---- Utility model ----

  // GET /api/settings/utility-model — get utility model config (without API key)
  app.get("/api/settings/utility-model", async () => {
    const config = deps.credentialStore.getUtilityModel();
    if (!config) return { configured: false };
    return { configured: true, provider: config.provider, model: config.model, baseUrl: config.baseUrl };
  });

  // PUT /api/settings/utility-model — set utility model config
  app.put<{ Body: { provider: string; apiKey?: string; model: string; baseUrl?: string } }>(
    "/api/settings/utility-model",
    async (request, reply) => {
      try {
        const result = setUtilityModel(
          deps.credentialStore,
          request.body.provider, request.body.apiKey, request.body.model, request.body.baseUrl,
        );
        return { configured: true, ...result };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to set utility model: ${getErrorMessage(err)}` });
      }
    },
  );

  // DELETE /api/settings/utility-model — clear utility model config
  app.delete("/api/settings/utility-model", async () => {
    clearUtilityModel(deps.credentialStore);
    return { configured: false };
  });

  // ---- Auth mutations ----

  // POST /api/auth/api-key — set API key
  app.post<{ Body: { key: string } }>(
    "/api/auth/api-key",
    async (request, reply) => {
      try {
        setApiKey(request.body.key);
        deps.authManager.kill();
        deps.authManager.checkCredentials();
        deps.sseBroadcast("auth_complete", {});
        return { success: true };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to set API key: ${getErrorMessage(err)}` });
      }
    },
  );

  // DELETE /api/auth/api-key — clear API key
  app.delete(
    "/api/auth/api-key",
    async () => {
      clearApiKey();
      const stillAuthenticated = deps.authManager.checkCredentials();
      if (!stillAuthenticated) {
        deps.authManager.startOAuthFlow();
      }
      return { success: true, stillAuthenticated };
    },
  );

  // POST /api/auth/start — initiate OAuth flow
  app.post(
    "/api/auth/start",
    async (_request, reply) => {
      try {
        startAuth(deps.authManager);
        reply.code(202).send({ success: true });
      } catch (err) {
        console.error("[auth] startAuth() threw:", err);
        reply.code(500).send({ error: `Failed to start auth: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/auth/code — submit OAuth authorization code
  app.post<{ Body: { code: string } }>(
    "/api/auth/code",
    async (request, reply) => {
      try {
        submitAuthCode(deps.authManager, request.body.code);
        return { success: true };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to submit auth code: ${getErrorMessage(err)}` });
      }
    },
  );

  // ---- Misc mutations ----

  // POST /api/reset — full reset
  app.post(
    "/api/reset",
    async (_request, reply) => {
      try {
        await fullReset(deps.sessionManager, deps.usageManager, deps.runnerRegistry, deps.workspaceDir, deps.repoStore, deps.databaseManager);
        deps.sseBroadcast("full_reset_complete", {});
        return { success: true };
      } catch (err) {
        reply.code(500).send({ error: `Full reset failed: ${getErrorMessage(err)}` });
      }
    },
  );
}
