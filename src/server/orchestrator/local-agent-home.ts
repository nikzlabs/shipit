import { perSessionCredentialsDir } from "./session-credentials-scaffold.js";
import type { AgentId } from "../shared/types/agent-types.js";
import type { AgentProcess, SessionInfo } from "../shared/types.js";
import type { AgentHomeResolver } from "../shared/agent-home.js";
import type { ProviderAccountManager } from "./provider-account-manager.js";
import { accountServiceForHarness, providerAccountCredentialRoot } from "./provider-account-manager.js";

export type LocalAgentFactory = (
  agentId: AgentId,
  resolveHome?: AgentHomeResolver,
) => AgentProcess;

export interface LocalAgentHomeDeps {
  sessionManager: { get(sessionId: string): SessionInfo | undefined };
  getTurnRoute?: (sessionId: string) => { kind: string; id: string } | undefined;
  providerAccountManager?: Pick<ProviderAccountManager, "selectRouteForTurn">;
  credentialsDir: string;
}

// Resolve at spawn time: failover can change the route on an existing runner.
export function resolveLocalAgentHome(
  sessionId: string,
  agentId: AgentId,
  deps: LocalAgentHomeDeps,
): string | undefined {
  const session = deps.sessionManager.get(sessionId);
  // eslint-disable-next-line no-restricted-syntax -- OpenCode needs an access-only ChatGPT projection in a private XDG home.
  if (agentId === "opencode" && session?.agentId === "opencode") return perSessionCredentialsDir(deps.credentialsDir, sessionId);

  // Keep the turn's selected route. Reserved routes use environment credentials and the global home.
  const turnRoute = deps.getTurnRoute?.(sessionId);
  if (session?.agentId === agentId && turnRoute) {
    return turnRoute.kind === "account"
      ? providerAccountCredentialRoot(deps.credentialsDir, agentId, turnRoute.id)
      : undefined;
  }

  const route = deps.providerAccountManager?.selectRouteForTurn(accountServiceForHarness(agentId));
  if (route?.kind === "account") {
    return providerAccountCredentialRoot(deps.credentialsDir, agentId, route.id);
  }

  return undefined;
}
