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
  listAgents,
  fullReset,
  startAuth,
  submitAuthCode,
  listProviderAccounts,
  createProviderAccount,
  renameProviderAccount,
  makePrimaryProviderAccount,
  deleteProviderAccount,
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
          deps.providerAccountManager,
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

  // ---- Provider accounts (docs/150) ----

  app.get("/api/provider-accounts", async () => {
    return listProviderAccounts(deps.providerAccountManager);
  });

  app.post<{ Body: { provider: AgentId; label?: string } }>(
    "/api/provider-accounts",
    async (request, reply) => {
      try {
        const result = createProviderAccount(deps.providerAccountManager, request.body.provider, request.body.label);
        deps.sseBroadcast("provider_accounts", { accounts: result.accounts });
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to create provider account: ${getErrorMessage(err)}` });
      }
    },
  );

  app.patch<{ Params: { provider: AgentId; accountId: string }; Body: { label: string } }>(
    "/api/provider-accounts/:provider/:accountId",
    async (request, reply) => {
      try {
        const result = renameProviderAccount(
          deps.providerAccountManager,
          request.params.provider,
          request.params.accountId,
          request.body.label,
        );
        deps.sseBroadcast("provider_accounts", { accounts: result.accounts });
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to rename provider account: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Params: { provider: AgentId; accountId: string } }>(
    "/api/provider-accounts/:provider/:accountId/primary",
    async (request, reply) => {
      try {
        const result = makePrimaryProviderAccount(
          deps.providerAccountManager,
          request.params.provider,
          request.params.accountId,
        );
        deps.agentRegistry.refreshAuth(request.params.provider);
        deps.sseBroadcast("provider_accounts", { accounts: result.accounts });
        deps.sseBroadcast("agent_list", { agents: listAgents(deps.agentRegistry), defaultAgentId: deps.defaultAgentId });
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to set primary provider account: ${getErrorMessage(err)}` });
      }
    },
  );

  app.delete<{ Params: { provider: AgentId; accountId: string } }>(
    "/api/provider-accounts/:provider/:accountId",
    async (request, reply) => {
      try {
        const result = deleteProviderAccount(
          deps.providerAccountManager,
          deps.sessionManager,
          deps.runnerRegistry,
          request.params.provider,
          request.params.accountId,
        );
        deps.agentRegistry.refreshAuth(request.params.provider);
        deps.sseBroadcast("provider_accounts", { accounts: result.accounts });
        deps.sseBroadcast("agent_list", { agents: listAgents(deps.agentRegistry), defaultAgentId: deps.defaultAgentId });
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to disconnect provider account: ${getErrorMessage(err)}` });
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

  // DELETE /api/auth/api-key — sign out of Claude. Clears both the stored
  // API key AND the OAuth credentials on disk, then refreshes the agent
  // registry so the card flips back to "Sign in". Mirrors DELETE
  // /api/codex-auth. We deliberately do NOT auto-restart the OAuth flow —
  // sign-out should leave the user signed out until they click "Sign in".
  app.delete(
    "/api/auth/api-key",
    async (_request, reply) => {
      try {
        clearApiKey();
        deps.authManager.signOut();
        // Drop the stored Claude provider-account rows so authConfigured
        // actually flips to false. `hasAnyAuthForProvider("claude")` returns
        // true if any account row exists (see docs/150), so leaving the
        // migrated `claude-default` row in place would leave the UI showing
        // "Authenticated" even though we just wiped the credentials. We only
        // drop the row, not the on-disk dir, so the legacy symlinks at
        // `<credentialsDir>/.claude` keep pointing at a usable target for the
        // next sign-in. The `auth_complete` listener in `app-lifecycle.ts`
        // re-registers the row via `migrateDefaultAccounts()`.
        for (const account of deps.providerAccountManager.list("claude")) {
          deps.credentialStore.deleteProviderAccount("claude", account.id);
        }
        deps.agentRegistry.refreshAuth("claude");
        const agents = listAgents(deps.agentRegistry);
        deps.sseBroadcast("agent_list", { agents, defaultAgentId: deps.defaultAgentId });
        deps.sseBroadcast("provider_accounts", { accounts: deps.providerAccountManager.list() });
        return { success: true, agents };
      } catch (err) {
        reply.code(500).send({ error: `Failed to sign out of Claude: ${getErrorMessage(err)}` });
      }
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
        // Mirror the Claude sign-out: drop stored Codex provider-account rows
        // so `hasAnyAuthForProvider("codex")` reflects the wiped credentials.
        // See the matching block in DELETE /api/auth/api-key for the rationale.
        for (const account of deps.providerAccountManager.list("codex")) {
          deps.credentialStore.deleteProviderAccount("codex", account.id);
        }
        deps.agentRegistry.refreshAuth("codex");
        const agents = deps.agentRegistry.list().map((a) => ({
          id: a.id, name: a.name, installed: a.installed,
          authConfigured: a.authConfigured, models: a.capabilities.models,
          supportsReview: a.capabilities.supportsReview,
          supportsSteering: a.capabilities.supportsSteering,
          supportedPermissionModes: a.capabilities.supportedPermissionModes,
        }));
        deps.sseBroadcast("agent_list", { agents, defaultAgentId: deps.defaultAgentId });
        deps.sseBroadcast("provider_accounts", { accounts: deps.providerAccountManager.list() });
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
