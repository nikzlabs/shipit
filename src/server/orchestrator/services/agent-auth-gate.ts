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

/**
 * docs/252 phase 9 (req 14) — the single turn-admission gate: `null` to admit,
 * otherwise the reason to refuse.
 *
 * **Installed is checked before authenticated**, and this is the one place that
 * has to check it. A session can arrive holding an agent that no selection path
 * offered — a session pinned before the deployment dropped that harness, a stale
 * `vibe-agent-id` in a browser, a headless/Quick-Capture agent derived from the
 * static catalogue, a child inheriting its parent's agent, a plugin-install
 * session. Gating each of those separately is a list that grows and gets missed;
 * gating here catches every one of them at the last point before a CLI is
 * spawned, which is what the design named as the gate that matters most.
 *
 * The order matters for the message, not just the check: "sign in to Claude" is
 * a dead end on an install that has no Claude Code to sign into.
 */
export function agentAdmissionError(
  agentRegistry: Pick<AgentRegistry, "refreshAuth" | "get">,
  agentId: AgentId,
): string | null {
  const info = agentRegistry.get(agentId);
  if (info && !info.installed) {
    return `${info.name} is not installed in this deployment. Pick another agent, or ask the operator to add it and redeploy.`;
  }
  return isAgentAuthenticated(agentRegistry, agentId) ? null : agentAuthenticationError(agentId);
}
