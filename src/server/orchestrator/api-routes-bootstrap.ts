/**
 * Bootstrap and global settings API routes.
 * Handles: GET /bootstrap, settings, auth, reset.
 */

import { loginIntegrationForService, nativeServiceForHarness } from "../shared/catalogue/index.js";
import type { FastifyInstance } from "fastify";
import { releaseResidentForCredentialChange } from "./resident-spawn-guard.js";
import type { AgentId } from "../shared/types.js";
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
  /**
   * docs/252 phase 2 — make a credential change reach the sessions already
   * running, rather than only the next one to start.
   *
   * Same two steps an MCP secret write takes: re-sync every live compose
   * stack's agent env (which is the path a compose-backed session's credentials
   * travel, and the gap Appendix A recorded), and push the freshly-collected
   * set to compose-less runners, whose env comes straight from the store.
   * Fire-and-forget — a settings write must not fail because one session's
   * stack is unhealthy.
   */
  const propagateCredentialChange = (): void => {
    // The orchestrator's own view of "is this provider authenticated" is a
    // CACHE, refreshed explicitly (`AgentRegistry.refreshAuth`) rather than
    // recomputed on read. A credential write that updates storage and the
    // environment but not the cache leaves the product disagreeing with itself:
    // the key is stored and delivered, and the agent is still un-selectable
    // until something else happens to refresh. Removal has the mirror-image
    // false positive. Every registered agent, because a credential is no longer
    // owned by one of them.
    for (const agent of deps.agentRegistry.list()) deps.agentRegistry.refreshAuth(agent.id);
    // docs/257 — `buildAgentListPayload`, not a bare `{ agents }`: a credential
    // write can make an install runnable or stop it being runnable, so this
    // broadcast has to carry `canRunTurns`. Sending the old shape here would
    // leave every other tab with a stale signal and a composer that disagrees
    // with what the server will accept.
    deps.sseBroadcast("agent_list", buildAgentListPayload(deps.agentRegistry, deps.credentialStore, deps.providerAccountManager));

    refreshAgentEnvForAllSessions(deps.serviceManagers ?? new Map<string, ServiceManager>());
    for (const sessionId of deps.runnerRegistry.ids()) {
      const runner = deps.runnerRegistry.get(sessionId);
      // docs/252 phase 3 — pushing the new environment is not enough for a
      // session with a RESIDENT CLI: that process read its credential at spawn
      // and never re-reads it, so a rotated key stayed old and a deleted one
      // kept working. Released here so the next turn respawns on what the store
      // now holds; a runner mid-turn is skipped rather than having its work
      // aborted.
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
  app.put<{ Body: {
    gitIdentity?: { name: string; email: string };
    systemPrompt?: string;
    maxIdleContainers?: number;
    agentSystemInstructionsEnabled?: boolean;
    autoCreatePr?: boolean;
    liveSteering?: boolean;
    /** docs/146 — global gate for the auto-resolve-conflicts loop. */
    autoResolveConflicts?: boolean;
    /** docs/169 — global gate for the auto-fix-CI loop. */
    autoFixCi?: boolean;
    /** docs/218 — global gate for auto-resetting a merged session's branch on continue. */
    autoResetMergedBranch?: boolean;
    /** docs/144 — global gate for sub-agent spawning. */
    enableSubAgents?: boolean;
    /** docs/163 — voice-note delivery mode (native / external / both). */
    voiceDeliveryMode?: "native" | "external" | "both";
    /** docs/150 reqs 4-6 — per-provider proactive failover cutoffs (1-100). */
    failoverCutoffs?: Record<string, { session?: number; weekly?: number }>;
    /** docs/150 req 21 — per-provider account selection mode. */
    accountSelectionMode?: Record<string, "strict" | "balanced">;
    /**
     * docs/252 phase 7 (req 9) — pin the model non-turn work runs on, or `null`
     * to clear the pin and follow the install again.
     */
    nonTurnModel?: { serviceId: string; billingMode: "sub" | "key"; modelId: string } | null;
    /**
     * docs/261 phase 3 (reqs 1, 5, 8) — pin a reviewer slot (`"first"` /
     * `"second"`) to a whole `(service, billing mode, model)` triple plus a
     * reasoning level, or `null` to return it to auto-configuration.
     *
     * Deliberately `unknown` per slot rather than the pin shape: the values
     * are validated in `saveGlobalSettings`, which is where an unknown slot, a
     * malformed triple, a level the derived harness does not offer, and a model
     * nothing installed can run each get their own 400. Declaring the shape
     * here would let Fastify's own coercion answer first, with a worse message.
     */
    reviewers?: Record<string, unknown>;
  } }>(
    "/api/settings",
    async (request, reply) => {
      try {
        return await saveGlobalSettings({
          agentRegistry: deps.agentRegistry,
          appWorkspaceDir: deps.workspaceDir,
          credentialStore: deps.credentialStore,
          providerAccountManager: deps.providerAccountManager,
          // docs/146 — when the user toggles autoResolveConflicts false → true,
          // re-broadcast every tracked session's snapshot so the (now-ungated)
          // `autoResolve` block lands on existing connected clients without
          // waiting for a genuine PR-status change.
          onAutoResolveConflictsEnabled: () => {
            deps.prStatusPoller?.broadcastAllSnapshots();
          },
          // docs/169 — same re-broadcast on the auto-fix-CI false → true edge so
          // the auto-loop's effect is reflected without waiting for a poll.
          onAutoFixCiEnabled: () => {
            deps.prStatusPoller?.broadcastAllSnapshots();
          },
          ...(request.body.gitIdentity !== undefined ? { gitIdentity: request.body.gitIdentity } : {}),
          ...(request.body.systemPrompt !== undefined ? { systemPrompt: request.body.systemPrompt } : {}),
          ...(request.body.maxIdleContainers !== undefined ? { maxIdleContainers: request.body.maxIdleContainers } : {}),
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
        // docs/252 phase 2 — a catalogue `storageEnv` name written here IS a
        // credential now (`setAgentEnv` routes it into the credential store), so
        // it owes the same propagation the Services surface does. Without it a
        // key saved from the Codex tab or from onboarding reached storage and
        // left a running compose-backed session on its previous snapshot.
        //
        // docs/257 — this is also how a Codex API key is stored, so it is a
        // producer of "the install can run something" and has to announce it:
        // the route used to broadcast NOTHING, leaving every other tab with a
        // stale `canRunTurns: false` and a disabled composer until its next
        // bootstrap. `propagateCredentialChange` carries that broadcast, with
        // the `buildAgentListPayload` shape docs/257 needs.
        propagateCredentialChange();
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

  // ---- Credential routes (docs/252 phase 2) ----
  //
  // String-delivered credentials only: a pasted API key, or a subscription
  // authenticated by one. Account-backed subscriptions keep the docs/150
  // `/api/provider-accounts/...` flow below, which additionally drives a login
  // and owns a credential root on disk.
  //
  // No route ever returns a secret — `CredentialRoute` carries none — so there
  // is no redaction step here to forget.

  app.get("/api/credential-routes", async () => {
    return { routes: listCredentialRoutes(deps.credentialStore) };
  });

  app.post<{ Body: { serviceId: string; billingMode: string; secret: string; label?: string } }>(
    "/api/credential-routes",
    async (request, reply) => {
      try {
        const result = createStringCredential(deps.credentialStore, request.body);
        propagateCredentialChange();
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
        const result = deleteCredentialRoute(deps.credentialStore, request.params.routeId, deps.runnerRegistry);
        propagateCredentialChange();
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

  // docs/150 req 2 applied to a subscription's string credentials: the fallback
  // order within one `(service, billing mode)` group.
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

  // docs/150 req 2 — persist the user's fallback order for a provider.
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
        // `replacementAccountId` rides the query string because DELETE bodies
        // are not reliably forwarded by proxies and Fastify's JSON parser
        // rejects an empty-but-declared body (the FST_ERR_CTP_EMPTY_JSON_BODY
        // trap the client already works around elsewhere).
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
        // Fan out: the credential this row provided is gone for every
        // harness that could use it, not only the one that owned the flow.
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

  // ---- Provider-account scoped login (docs/150) ----
  // Kicks off / cancels / feeds the per-account login flow. Pending URL/code
  // and completion ride the existing `agent_auth_*` SSE family (now carrying
  // `accountId`), so the existing sign-in card surfaces the flow and the
  // account row's status pill updates from the `provider_accounts` broadcast.

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
        /*
          docs/252 req 9 — cancelling is a change in what the install can run,
          not merely a change to a row. `cancelAccountAuth` resets the account
          to **ready** when it already has credentials on disk (and to
          `unavailable` when it does not), and this route used to announce that
          only as an account update. The background-work setting is seeded and
          re-resolved from `agent_list` (`buildAgentListPayload`), so without
          this an install whose first ready credential arrives by *cancelling*
          out of a second sign-in would sit unseeded until the next page load.
          Found by the second round of cross-backend review.
        */
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

  // ---- Auth mutations ----

  // POST /api/auth/api-key — set API key
  app.post<{ Body: { key: string } }>(
    "/api/auth/api-key",
    async (request, reply) => {
      try {
        setApiKey(deps.credentialStore, request.body.key);
        propagateCredentialChange();
        deps.authManager.kill();
        deps.authManager.checkCredentials();
        // docs/155 Phase 2b — unified SSE event family. Setting an API key
        // is the "authentication finished" signal for Claude; the client's
        // `agent_auth_complete` handler refreshes the agent list.
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

  // DELETE /api/auth/api-key — sign out of Claude. Clears both the stored
  // API key AND the OAuth credentials on disk, then refreshes the agent
  // registry so the card flips back to "Sign in". Mirrors DELETE
  // /api/codex-auth. We deliberately do NOT auto-restart the OAuth flow —
  // sign-out should leave the user signed out until they click "Sign in".
  app.delete(
    "/api/auth/api-key",
    async (_request, reply) => {
      try {
        // docs/150 req 19 — one call that clears every connected account's
        // credentials *and* rows, then the singleton path for pre-account
        // installs. Dropping only the rows (what this did before) left the
        // OAuth tokens of every account past the migrated default on disk with
        // no row left to reach them from. Signing back in goes through "Add
        // account", which creates a fresh row.
        //
        // planning#285 — it also takes the account away from the sessions pinned to
        // it (resident agent retired, per-session credential copy revoked), and
        // carries the running-turn guard the per-account disconnect has: never
        // rewrite credentials under a live agent. It throws before touching
        // anything, so the API key below is cleared only once sign-out commits.
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
        // docs/257 — a provider-wide sign-out can remove the LAST credential on
        // the install, so this is one of the sites where `canRunTurns` must ride
        // the broadcast: omit it and the composer stays enabled over an install
        // that can no longer run anything, and the server refuses the message
        // the user was still allowed to type.
        const payload = buildAgentListPayload(deps.agentRegistry, deps.credentialStore, deps.providerAccountManager);
        deps.sseBroadcast("agent_list", payload);
        deps.sseBroadcast("provider_accounts", { accounts: deps.providerAccountManager.list() });
        // docs/252 phase 2 — signing out removes credentials, so the Services
        // surface has to hear about it too: `provider_accounts` alone leaves it
        // showing rows that no longer exist.
        deps.sseBroadcast("credential_routes", { routes: listCredentialRoutes(deps.credentialStore) });
        return { success: true, agents: payload.agents };
      } catch (err) {
        // The running-turn refusal is a 409 the user can act on, not a fault.
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to sign out of Claude: ${getErrorMessage(err)}` });
      }
    },
  );

  // docs/150 reqs 16/19 — the singleton subscription sign-in endpoints
  // (`POST /api/auth/start`, `POST /api/auth/code`, `POST /api/codex-auth/start`,
  // `POST /api/codex-auth/cancel`) are gone. They were the *other* way to
  // connect a subscription: no account id, one implicit flow per provider, and
  // a result the account rows couldn't manage. Every sign-in now goes through
  // `/api/provider-accounts/:provider/:accountId/login[/cancel|/code]` above,
  // which is the same path whether it's the user's first account or their
  // fifth. Sign-*out* is unchanged and still provider-wide below — it clears
  // credentials that predate accounts as well as the rows themselves.

  // ---- Codex (ChatGPT subscription) auth routes ----
  // See docs/119-codex-subscription-auth/plan.md.

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
        // Mirror the Claude sign-out — see the matching block in
        // DELETE /api/auth/api-key for why the per-account walk, the
        // per-session revoke and the running-turn guard are all required.
        signOutProvider(
          deps.providerAccountManager,
          deps.sessionManager,
          deps.runnerRegistry,
          "codex",
          { credentialsDir: deps.credentialsDir },
        );
        // After the walk: `signOutProvider` already cancels the device flow of
        // any row it deletes, so this only catches a flow with no row behind it
        // (legacy). Running it before the guard would abort someone's sign-in
        // for a sign-out that then 409s.
        deps.codexAuthManager.cancel();
        deps.agentRegistry.refreshAuthForLogin("openai-chatgpt");
        // docs/257 — same as the Claude sign-out above: the last credential can
        // go here, so the payload carries `canRunTurns`. The hand-rolled agent
        // list this replaced had also drifted from `listAgents` (no `reasoning`).
        const payload = buildAgentListPayload(deps.agentRegistry, deps.credentialStore, deps.providerAccountManager);
        deps.sseBroadcast("agent_list", payload);
        deps.sseBroadcast("provider_accounts", { accounts: deps.providerAccountManager.list() });
        // docs/252 phase 2 — see the Claude sign-out above.
        deps.sseBroadcast("credential_routes", { routes: listCredentialRoutes(deps.credentialStore) });
        return { success: true, agents: payload.agents };
      } catch (err) {
        // The running-turn refusal is a 409 the user can act on, not a fault.
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
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
