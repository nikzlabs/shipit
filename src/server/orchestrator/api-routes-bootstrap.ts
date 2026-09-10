import { loginIntegrationForService, nativeServiceForHarness } from "../shared/catalogue/index.js";
import type { FastifyInstance } from "fastify";
import { releaseResidentForCredentialChange } from "./resident-spawn-guard.js";
import type { AgentId, CredentialBillingMode } from "../shared/types.js";
import { limitsModeKey } from "../shared/types/usage-limits-types.js";
import type { ApiDeps } from "./api-routes.js";
import type { ServiceManager } from "./service-manager.js";

import {
  getBootstrapData,
  setGitIdentityService,
  saveGlobalSettings,
  setAgent,
  setAgentEnv,
  setApiKey,
  clearApiKey,
  buildAgentListPayload,
  fullReset,
  listProviderAccounts,
  createProviderAccount,
  renameProviderAccount,
  reorderProviderAccounts,
  deleteProviderAccount,
  startProviderAccountLogin,
  cancelProviderAccountLogin,
  submitProviderAccountCode,
  signOutProvider,
  listCredentialRoutes,
  createStringCredential,
  updateStringCredential,
  deleteCredentialRoute,
  reorderCredentialRoutes,
  ServiceError,
} from "./services/index.js";
import {
  isAgentSecretsCapable,
  refreshAgentEnvForAllSessions,
  selectAgentEnvForPush,
} from "./session-agent-env.js";
import { getErrorMessage } from "./validation.js";

export async function registerBootstrapRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const propagateCredentialChange = (): void => {
    // Auth status is cached; refresh every harness before building the broadcast.
    for (const agent of deps.agentRegistry.list()) deps.agentRegistry.refreshAuth(agent.id);
    deps.sseBroadcast("agent_list", buildAgentListPayload(deps.agentRegistry, deps.credentialStore, deps.providerAccountManager));

    refreshAgentEnvForAllSessions(deps.serviceManagers ?? new Map<string, ServiceManager>());
    for (const sessionId of deps.runnerRegistry.ids()) {
      const runner = deps.runnerRegistry.get(sessionId);
      // Resident CLIs retain spawn-time credentials; release idle ones for the next turn.
      releaseResidentForCredentialChange(deps.runnerRegistry.get(sessionId));
      if (!isAgentSecretsCapable(runner)) continue;
      void runner
        .tryPushAgentSecrets(
          selectAgentEnvForPush({
            serviceManager: runner.serviceManager ?? null,
            credentialStore: deps.credentialStore,
          }),
        )
        .catch((err: unknown) => {
          console.warn(`[credentials] agent-env push failed for ${sessionId}:`, getErrorMessage(err));
        });
    }
  };

  // A replaced secret needs a manual refresh; seed can retain the old route's cache.
  const refreshQuotaForCredential = (
    route: { serviceId: string; billingMode: CredentialBillingMode; id: string },
    reason: "manual" | "seed",
  ): void => {
    if (route.billingMode !== "sub" || !deps.refreshSubscriptionLimits) return;
    void deps.refreshSubscriptionLimits(limitsModeKey(route), reason, route.id).catch((err: unknown) => {
      console.warn(`[limits] quota refresh for ${route.id} failed:`, getErrorMessage(err));
    });
  };

  const forgetQuotaForCredential = (
    route: { serviceId: string; billingMode: CredentialBillingMode; id: string },
  ): void => {
    if (route.billingMode !== "sub") return;
    deps.forgetSubscriptionLimits?.(limitsModeKey(route), route.id);
  };

  app.get("/api/bootstrap", async () => {
    return getBootstrapData(deps);
  });

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

  app.put<{ Body: {
    gitIdentity?: { name: string; email: string };
    systemPrompt?: string;
    memoryBudgetMb?: number | null;
    agentSystemInstructionsEnabled?: boolean;
    autoCreatePr?: boolean;
    liveSteering?: boolean;
    autoResolveConflicts?: boolean;
    autoFixCi?: boolean;
    autoResetMergedBranch?: boolean;
    enableSubAgents?: boolean;
    voiceDeliveryMode?: "native" | "external" | "both";
    failoverCutoffs?: Record<string, { session?: number; weekly?: number }>;
    accountSelectionMode?: Record<string, "strict" | "balanced">;
    nonTurnModel?: { serviceId: string; billingMode: "sub" | "key"; modelId: string } | null;
    reviewers?: Record<string, unknown>;
    roles?: Record<string, unknown>;
  } }>(
    "/api/settings",
    async (request, reply) => {
      try {
        return await saveGlobalSettings({
          agentRegistry: deps.agentRegistry,
          appWorkspaceDir: deps.workspaceDir,
          credentialStore: deps.credentialStore,
          providerAccountManager: deps.providerAccountManager,
          onAutoResolveConflictsEnabled: () => {
            deps.prStatusPoller?.broadcastAllSnapshots();
          },
          onAutoFixCiEnabled: () => {
            deps.prStatusPoller?.broadcastAllSnapshots();
          },
          ...(request.body.gitIdentity !== undefined ? { gitIdentity: request.body.gitIdentity } : {}),
          ...(request.body.systemPrompt !== undefined ? { systemPrompt: request.body.systemPrompt } : {}),
          ...(request.body.memoryBudgetMb !== undefined ? { memoryBudgetMb: request.body.memoryBudgetMb } : {}),
          ...(request.body.agentSystemInstructionsEnabled !== undefined ? { agentSystemInstructionsEnabled: request.body.agentSystemInstructionsEnabled } : {}),
          ...(request.body.autoCreatePr !== undefined ? { autoCreatePr: request.body.autoCreatePr } : {}),
          ...(request.body.liveSteering !== undefined ? { liveSteering: request.body.liveSteering } : {}),
          ...(request.body.autoResolveConflicts !== undefined ? { autoResolveConflicts: request.body.autoResolveConflicts } : {}),
          ...(request.body.autoFixCi !== undefined ? { autoFixCi: request.body.autoFixCi } : {}),
          ...(request.body.autoResetMergedBranch !== undefined ? { autoResetMergedBranch: request.body.autoResetMergedBranch } : {}),
          ...(request.body.enableSubAgents !== undefined ? { enableSubAgents: request.body.enableSubAgents } : {}),
          ...(request.body.voiceDeliveryMode !== undefined ? { voiceDeliveryMode: request.body.voiceDeliveryMode } : {}),
          ...(request.body.failoverCutoffs !== undefined ? { failoverCutoffs: request.body.failoverCutoffs } : {}),
          ...(request.body.accountSelectionMode !== undefined ? { accountSelectionMode: request.body.accountSelectionMode } : {}),
          ...(request.body.nonTurnModel !== undefined ? { nonTurnModel: request.body.nonTurnModel } : {}),
          ...(request.body.reviewers !== undefined ? { reviewers: request.body.reviewers } : {}),
          ...(request.body.roles !== undefined ? { roles: request.body.roles } : {}),
        });
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to save settings: ${getErrorMessage(err)}` });
      }
    },
  );

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

  app.post<{ Params: { id: string }; Body: { key: string; value: string } }>(
    "/api/agents/:id/env",
    async (request, reply) => {
      try {
        const result = setAgentEnv(
          deps.agentRegistry, deps.credentialStore,
          request.params.id as AgentId, request.body.key, request.body.value,
        );
        propagateCredentialChange();
        if (result.route) refreshQuotaForCredential(result.route, "manual");
        deps.sseBroadcast("credential_routes", { routes: listCredentialRoutes(deps.credentialStore) });
        return { agentId: result.agentId, key: result.key, success: true, agents: result.agents };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to set agent env: ${getErrorMessage(err)}` });
      }
    },
  );

  app.get("/api/credential-routes", async () => {
    return { routes: listCredentialRoutes(deps.credentialStore) };
  });

  app.post<{ Body: { serviceId: string; billingMode: string; secret: string; label?: string } }>(
    "/api/credential-routes",
    async (request, reply) => {
      try {
        const result = createStringCredential(deps.credentialStore, request.body);
        propagateCredentialChange();
        refreshQuotaForCredential(result.route, "seed");
        deps.sseBroadcast("credential_routes", { routes: result.routes });
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to save credential: ${getErrorMessage(err)}` });
      }
    },
  );

  app.patch<{ Params: { routeId: string }; Body: { label?: string; secret?: string } }>(
    "/api/credential-routes/:routeId",
    async (request, reply) => {
      try {
        const result = updateStringCredential(deps.credentialStore, request.params.routeId, request.body ?? {});
        propagateCredentialChange();
        if (request.body?.secret !== undefined) refreshQuotaForCredential(result.route, "manual");
        deps.sseBroadcast("credential_routes", { routes: result.routes });
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to update credential: ${getErrorMessage(err)}` });
      }
    },
  );

  app.delete<{ Params: { routeId: string } }>(
    "/api/credential-routes/:routeId",
    async (request, reply) => {
      try {
        const removed = deps.credentialStore.getCredentialRoute(request.params.routeId);
        const result = deleteCredentialRoute(deps.credentialStore, request.params.routeId, deps.runnerRegistry);
        propagateCredentialChange();
        if (removed) forgetQuotaForCredential(removed);
        deps.sseBroadcast("credential_routes", { routes: result.routes });
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to remove credential: ${getErrorMessage(err)}` });
      }
    },
  );

  app.put<{ Params: { serviceId: string; billingMode: string }; Body: { routeIds?: unknown } }>(
    "/api/credential-routes/:serviceId/:billingMode/order",
    async (request, reply) => {
      try {
        const result = reorderCredentialRoutes(
          deps.credentialStore,
          request.params.serviceId,
          request.params.billingMode,
          request.body?.routeIds,
        );
        propagateCredentialChange();
        deps.sseBroadcast("credential_routes", { routes: result.routes });
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to reorder credentials: ${getErrorMessage(err)}` });
      }
    },
  );

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

  app.put<{ Params: { provider: AgentId }; Body: { accountIds?: unknown } }>(
    "/api/provider-accounts/:provider/order",
    async (request, reply) => {
      try {
        const result = reorderProviderAccounts(
          deps.providerAccountManager,
          request.params.provider,
          request.body?.accountIds,
        );
        deps.sseBroadcast("provider_accounts", { accounts: result.accounts });
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to reorder provider accounts: ${getErrorMessage(err)}` });
      }
    },
  );


  app.delete<{
    Params: { provider: AgentId; accountId: string };
    Querystring: { replacementAccountId?: string };
  }>(
    "/api/provider-accounts/:provider/:accountId",
    async (request, reply) => {
      try {
        const replacementAccountId = request.query.replacementAccountId?.trim();
        const result = deleteProviderAccount(
          deps.providerAccountManager,
          deps.sessionManager,
          deps.runnerRegistry,
          request.params.provider,
          request.params.accountId,
          {
            credentialsDir: deps.credentialsDir,
            ...(replacementAccountId ? { replacementAccountId } : {}),
          },
        );
        const disconnectedLogin = loginIntegrationForService(
          nativeServiceForHarness(request.params.provider),
        );
        if (disconnectedLogin) deps.agentRegistry.refreshAuthForLogin(disconnectedLogin);
        else deps.agentRegistry.refreshAuth(request.params.provider);
        deps.sseBroadcast("provider_accounts", { accounts: result.accounts });
        deps.sseBroadcast("agent_list", buildAgentListPayload(deps.agentRegistry, deps.credentialStore, deps.providerAccountManager));
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

  app.post<{ Params: { provider: AgentId; accountId: string } }>(
    "/api/provider-accounts/:provider/:accountId/login",
    async (request, reply) => {
      try {
        const result = startProviderAccountLogin(
          deps.providerAccountManager,
          request.params.provider,
          request.params.accountId,
        );
        deps.sseBroadcast("provider_accounts", { accounts: result.accounts });
        reply.code(202).send({ success: true, account: result.account });
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to start account login: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Params: { provider: AgentId; accountId: string } }>(
    "/api/provider-accounts/:provider/:accountId/login/cancel",
    async (request, reply) => {
      try {
        const result = cancelProviderAccountLogin(
          deps.providerAccountManager,
          request.params.provider,
          request.params.accountId,
        );
        deps.sseBroadcast("provider_accounts", { accounts: result.accounts });
        // Cancelling can restore a credentialed account to ready; refresh before broadcast.
        const cancelledLogin = loginIntegrationForService(
          nativeServiceForHarness(request.params.provider),
        );
        if (cancelledLogin) deps.agentRegistry.refreshAuthForLogin(cancelledLogin);
        else deps.agentRegistry.refreshAuth(request.params.provider);
        deps.sseBroadcast("agent_list", buildAgentListPayload(deps.agentRegistry, deps.credentialStore, deps.providerAccountManager));
        return { success: true, account: result.account };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to cancel account login: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Params: { provider: AgentId; accountId: string }; Body: { code: string } }>(
    "/api/provider-accounts/:provider/:accountId/login/code",
    async (request, reply) => {
      try {
        submitProviderAccountCode(
          deps.providerAccountManager,
          request.params.provider,
          request.params.accountId,
          request.body.code,
        );
        return { success: true };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to submit account login code: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Body: { key: string } }>(
    "/api/auth/api-key",
    async (request, reply) => {
      try {
        setApiKey(deps.credentialStore, request.body.key);
        propagateCredentialChange();
        deps.authManager.kill();
        deps.authManager.checkCredentials();
        deps.sseBroadcast("agent_auth_complete", { loginId: "anthropic-oauth" });
        deps.sseBroadcast("credential_routes", { routes: listCredentialRoutes(deps.credentialStore) });
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

  app.delete(
    "/api/auth/api-key",
    async (_request, reply) => {
      try {
        // Sign-out can refuse an active turn; clear the API key only after it succeeds.
        signOutProvider(
          deps.providerAccountManager,
          deps.sessionManager,
          deps.runnerRegistry,
          "claude",
          { credentialsDir: deps.credentialsDir },
        );
        clearApiKey(deps.credentialStore);
        propagateCredentialChange();
        deps.agentRegistry.refreshAuthForLogin("anthropic-oauth");
        const payload = buildAgentListPayload(deps.agentRegistry, deps.credentialStore, deps.providerAccountManager);
        deps.sseBroadcast("agent_list", payload);
        deps.sseBroadcast("provider_accounts", { accounts: deps.providerAccountManager.list() });
        deps.sseBroadcast("credential_routes", { routes: listCredentialRoutes(deps.credentialStore) });
        return { success: true, agents: payload.agents };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to sign out of Claude: ${getErrorMessage(err)}` });
      }
    },
  );

  app.delete(
    "/api/codex-auth",
    async (_request, reply) => {
      try {
        signOutProvider(
          deps.providerAccountManager,
          deps.sessionManager,
          deps.runnerRegistry,
          "codex",
          { credentialsDir: deps.credentialsDir },
        );
        // Cancel the legacy flow only after sign-out passes its active-turn guard.
        deps.codexAuthManager.cancel();
        deps.agentRegistry.refreshAuthForLogin("openai-chatgpt");
        const payload = buildAgentListPayload(deps.agentRegistry, deps.credentialStore, deps.providerAccountManager);
        deps.sseBroadcast("agent_list", payload);
        deps.sseBroadcast("provider_accounts", { accounts: deps.providerAccountManager.list() });
        deps.sseBroadcast("credential_routes", { routes: listCredentialRoutes(deps.credentialStore) });
        return { success: true, agents: payload.agents };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to sign out of Codex: ${getErrorMessage(err)}` });
      }
    },
  );

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
