import type { AgentRegistry } from "../../shared/agent-registry.js";
import { isHarnessInstalled } from "../../shared/installed-harnesses.js";
import type { AgentId } from "../../shared/types.js";

const AUTH_ERROR: Record<AgentId, string> = {
  claude: "Claude is not authenticated. Sign in to Claude or add ANTHROPIC_API_KEY in Settings → Agents.",
  codex: "Codex is not authenticated. Sign in to Codex or add OPENAI_API_KEY in Settings → Agents.",
  opencode: "OpenCode has no usable credential. Add an API key for a service OpenCode can run in Settings → Agents.",
  grok: "Grok Build is not authenticated. Add XAI_API_KEY in Settings → Agents.",
};

export function agentAuthenticationError(agentId: AgentId): string {
  return AUTH_ERROR[agentId];
}

// The registry includes stored accounts; singleton auth managers only see the legacy root.
export function isAgentAuthenticated(
  agentRegistry: Pick<AgentRegistry, "refreshAuth" | "get">,
  agentId: AgentId,
): boolean {
  agentRegistry.refreshAuth(agentId);
  return agentRegistry.get(agentId)?.hasRunnableModels ?? false;
}

// Use declared installation, not a PATH probe; missing binaries cannot be fixed by signing in.
export function agentAdmissionError(
  agentRegistry: Pick<AgentRegistry, "refreshAuth" | "get">,
  agentId: AgentId,
): string | null {
  if (!isHarnessInstalled(agentId)) {
    const name = agentRegistry.get(agentId)?.name ?? agentId;
    return `${name} is not installed in this deployment. Pick another agent, or ask the operator to add it and redeploy.`;
  }
  return isAgentAuthenticated(agentRegistry, agentId) ? null : agentAuthenticationError(agentId);
}
