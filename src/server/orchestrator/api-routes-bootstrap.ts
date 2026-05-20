/**
 * Bootstrap and global settings API routes.
 * Handles: GET /bootstrap, settings, auth, reset.
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
  app.put<{ Body: { gitIdentity?: { name: string; email: string }; systemPrompt?: string; maxIdleContainers?: number; agentSystemInstructionsEnabled?: boolean; autoCreatePr?: boolean; liveSteering?: boolean } }>(
    "/api/settings",
    async (request, reply) => {
      try {
        return await saveGlobalSettings(
          deps.agentRegistry, deps.defaultAgentId, deps.workspaceDir, deps.credentialStore,
          request.body.gitIdentity, request.body.systemPrompt, request.body.maxIdleContainers,
          request.body.agentSystemInstructionsEnabled, request.body.autoCreatePr, request.body.liveSteering,
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

  // ---- Codex (ChatGPT subscription) auth routes ----
  // See docs/119-codex-subscription-auth/plan.md.

  /**
   * POST /api/codex-auth/start — kick off `codex login --device-auth`.
   * Idempotent: returning 202 even when a flow is already in flight is the
   * documented behavior (the manager itself no-ops repeat calls). The actual
   * URL + user code stream over SSE as a `codex_auth_pending` event.
   */
  app.post(
    "/api/codex-auth/start",
    async (_request, reply) => {
      try {
        deps.codexAuthManager.startDeviceFlow();
        reply.code(202).send({ success: true, pending: deps.codexAuthManager.pending });
      } catch (err) {
        console.error("[codex-auth] startDeviceFlow() threw:", err);
        reply.code(500).send({ error: `Failed to start Codex auth: ${getErrorMessage(err)}` });
      }
    },
  );

  /**
   * POST /api/codex-auth/cancel — abort an in-flight device flow. SIGTERMs
   * the underlying `codex login` so it stops polling. Idempotent.
   */
  app.post(
    "/api/codex-auth/cancel",
    async (_request, reply) => {
      try {
        deps.codexAuthManager.cancel();
        return { success: true };
      } catch (err) {
        reply.code(500).send({ error: `Failed to cancel Codex auth: ${getErrorMessage(err)}` });
      }
    },
  );

  /**
   * DELETE /api/codex-auth — sign out of the ChatGPT subscription. Removes
   * `~/.codex/auth.json` and refreshes the agent registry so a downstream
   * turn falls back to `OPENAI_API_KEY` (or to `auth_required` if no key
   * is set either).
   */
  app.delete(
    "/api/codex-auth",
    async (_request, reply) => {
      try {
        deps.codexAuthManager.cancel();
        deps.codexAuthManager.signOut();
        deps.agentRegistry.refreshAuth("codex");
        const agents = deps.agentRegistry.list().map((a) => ({
          id: a.id, name: a.name, installed: a.installed,
          authConfigured: a.authConfigured, models: a.capabilities.models,
          supportsReview: a.capabilities.supportsReview,
          supportsSteering: a.capabilities.supportsSteering,
          supportedPermissionModes: a.capabilities.supportedPermissionModes,
        }));
        deps.sseBroadcast("agent_list", { agents, defaultAgentId: deps.defaultAgentId });
        return { success: true, agents };
      } catch (err) {
        reply.code(500).send({ error: `Failed to sign out of Codex: ${getErrorMessage(err)}` });
      }
    },
  );

  // ---- Misc mutations ----

  // POST /api/reset — full reset
  app.post(
    "/api/reset",
    async (_request, reply) => {
      try {
        await fullReset(
          deps.sessionManager,
          deps.usageManager,
          deps.runnerRegistry,
          deps.workspaceDir,
          deps.repoStore,
          deps.databaseManager,
          deps.composeStopPromises,
          deps.credentialsDir,
        );
        deps.sseBroadcast("full_reset_complete", {});
        return { success: true };
      } catch (err) {
        reply.code(500).send({ error: `Full reset failed: ${getErrorMessage(err)}` });
      }
    },
  );
}
