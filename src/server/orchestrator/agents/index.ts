/**
 * Per-agent runtime tables (docs/155 Phase 5).
 *
 * `buildAgentRuntime()` assembles the four lookup tables the orchestrator
 * consumes at runtime — auth managers (keyed by `LoginIntegrationId`), limits
 * providers, run-params prep hooks and system-prompt fragments (keyed by
 * `AgentId`). Each table draws from the
 * per-agent barrels (`./claude/`, `./codex/`), so adding a new backend is
 * one new folder + one entry per table here.
 *
 * The auth managers themselves are constructed in `app-di.ts` (they're
 * lifecycle-coupled to startup and tests inject their own); this module just
 * packages already-constructed instances into the keyed map. Limits providers
 * and run-params preps are constructed here because they have no per-test
 * injection surface today.
 */

import type { AgentId } from "../../shared/types.js";
import type { LoginIntegrationId } from "../../shared/catalogue/types.js";
import type { AgentAuthManager } from "../agent-auth-manager.js";
import type { LimitsProvider } from "./types.js";
import type { PrepareRunParamsFn } from "../agent-run-params-prep.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import * as claude from "./claude/index.js";
import * as codex from "./codex/index.js";

export interface BuildAgentRuntimeDeps {
  /** Already-constructed Claude OAuth manager from `app-di`. */
  authManager: claude.AuthManager;
  /** Already-constructed Codex device-flow manager from `app-di`. */
  codexAuthManager: codex.CodexAuthManager;
  /**
   * docs/150 — provider-account registry, so a limits provider can enumerate
   * connected accounts and resolve a route id to the credential dir whose token
   * that route's usage must be fetched with. Optional: without it the providers
   * keep their pre-docs/150 behaviour (cached routes only, root credentials).
   */
  providerAccountManager?: ProviderAccountManager;
}

export interface AgentRuntime {
  /** Auth managers keyed by LOGIN FLOW. See `AgentAuthManager`. */
  authManagers: Map<LoginIntegrationId, AgentAuthManager>;
  /** Subscription rate-limit providers keyed by agent id. */
  limitsProviders: Map<AgentId, LimitsProvider>;
  /** Pure run-params prep hooks keyed by agent id. */
  runParamsPreps: Map<AgentId, PrepareRunParamsFn>;
  /**
   * Per-agent "Parallel sessions" system-prompt fragments, keyed by agent id.
   * Consumed by `agent-instructions.ts buildAgentSystemInstructions`. Backends
   * without a fragment omit themselves and get the empty string at the call
   * site.
   */
  parallelSessionsSections: Map<AgentId, string>;
}

/**
 * Build the per-agent runtime tables. Add a new backend by importing its
 * barrel above, then appending one entry to each map.
 */
export function buildAgentRuntime(deps: BuildAgentRuntimeDeps): AgentRuntime {
  // Keyed by LOGIN FLOW, not by harness — see `AgentAuthManager`. The key is
  // each manager's own `loginId`, so the table cannot disagree with the
  // managers it holds.
  const authManagers = new Map<LoginIntegrationId, AgentAuthManager>(
    [deps.authManager, deps.codexAuthManager].map((mgr) => [mgr.loginId, mgr]),
  );

  const limitsProviders = new Map<AgentId, LimitsProvider>([
    ["claude", new claude.ClaudeLimitsProvider({
      authManager: deps.authManager,
      ...(deps.providerAccountManager
        ? {
            listAccountRouteIds: () =>
              deps.providerAccountManager!.list("anthropic")
                .filter((account) => account.status === "ready" || account.status === "authenticating")
                .map((account) => account.id),
            // Reserved routes (`claude-env-oauth`, `claude-api-key`) are not
            // account rows; `undefined` sends them down the env/legacy path,
            // which is the correct source for them.
            credentialDirForRoute: (routeId: string) =>
              deps.providerAccountManager!.get("anthropic", routeId)
                ? deps.providerAccountManager!.resolveCredentialRoot("claude", routeId)
                : undefined,
          }
        : {}),
    })],
    ["codex", new codex.CodexLimitsProvider({ codexAuthManager: deps.codexAuthManager })],
  ]);

  const runParamsPreps = new Map<AgentId, PrepareRunParamsFn>([
    ["claude", claude.prepareClaudeRunParams],
    ["codex", codex.prepareCodexRunParams],
  ]);

  const parallelSessionsSections = new Map<AgentId, string>([
    ["claude", claude.CLAUDE_PARALLEL_SESSIONS_SECTION],
    ["codex", codex.CODEX_PARALLEL_SESSIONS_SECTION],
  ]);

  return { authManagers, limitsProviders, runParamsPreps, parallelSessionsSections };
}
