import type { AgentId } from "../../shared/types.js";
import type { LoginIntegrationId } from "../../shared/catalogue/types.js";
import type { AgentAuthManager } from "../agent-auth-manager.js";
import type { LimitsProvider } from "./types.js";
import type { PrepareRunParamsFn } from "../agent-run-params-prep.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import * as claude from "./claude/index.js";
import * as codex from "./codex/index.js";
import * as opencode from "./opencode/index.js";
import * as grok from "./grok/index.js";

export interface BuildAgentRuntimeDeps {
  authManager: claude.AuthManager;
  codexAuthManager: codex.CodexAuthManager;
  xaiAuthManager?: grok.XaiAuthManager;
  providerAccountManager?: ProviderAccountManager;
}

export interface AgentRuntime {
  authManagers: Map<LoginIntegrationId, AgentAuthManager>;
  limitsProviders: Map<AgentId, LimitsProvider>;
  runParamsPreps: Map<AgentId, PrepareRunParamsFn>;
  parallelSessionsSections: Map<AgentId, string>;
}

export function buildAgentRuntime(deps: BuildAgentRuntimeDeps): AgentRuntime {
  const declared: (AgentAuthManager | undefined)[] = [
    deps.authManager,
    deps.codexAuthManager,
    deps.xaiAuthManager,
  ];
  const authManagers = new Map<LoginIntegrationId, AgentAuthManager>(
    declared.filter((mgr) => mgr !== undefined).map((mgr) => [mgr.loginId, mgr]),
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
            // Reserved env/key routes have no account row; use the legacy credential path.
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
    ["opencode", opencode.prepareOpencodeRunParams],
    ["grok", grok.prepareGrokRunParams],
  ]);

  const parallelSessionsSections = new Map<AgentId, string>([
    ["claude", claude.CLAUDE_PARALLEL_SESSIONS_SECTION],
    ["codex", codex.CODEX_PARALLEL_SESSIONS_SECTION],
    ["opencode", opencode.OPENCODE_PARALLEL_SESSIONS_SECTION],
    ["grok", grok.GROK_PARALLEL_SESSIONS_SECTION],
  ]);

  return { authManagers, limitsProviders, runParamsPreps, parallelSessionsSections };
}
