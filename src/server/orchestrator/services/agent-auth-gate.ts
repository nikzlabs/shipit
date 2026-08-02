import type { AgentRegistry } from "../../shared/agent-registry.js";
import type { AgentId } from "../../shared/types.js";

const AUTH_ERROR: Record<AgentId, string> = {
  claude: "Claude is not authenticated. Sign in to Claude or add ANTHROPIC_API_KEY in Settings → Agents.",
  codex: "Codex is not authenticated. Sign in to Codex or add OPENAI_API_KEY in Settings → Agents.",
};

export function agentAuthenticationError(agentId: AgentId): string {
  return AUTH_ERROR[agentId];
}

/**
 * Re-read the account-aware authentication source before admitting a turn.
 *
 * AgentRegistry is constructed with ProviderAccountManager-backed checks, so
 * this recognizes any ready stored subscription account as well as an explicit
 * reserved env/API-key route. The legacy singleton Claude AuthManager cannot
 * answer that question: its root credential path does not contain newly added
 * provider-account subscriptions.
 */
export function isAgentAuthenticated(
  agentRegistry: Pick<AgentRegistry, "refreshAuth" | "get">,
  agentId: AgentId,
): boolean {
  agentRegistry.refreshAuth(agentId);
  return agentRegistry.get(agentId)?.authConfigured ?? false;
}
