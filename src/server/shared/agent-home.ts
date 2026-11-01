export const DEFAULT_AGENT_HOME = "/home/shipit";

// Resolve at call time: local mode and session containers use different homes.
export function agentHome(): string {
  return process.env.AGENT_HOME || DEFAULT_AGENT_HOME;
}

export function codexHome(): string {
  return process.env.CODEX_HOME || `${agentHome()}/.codex`;
}

/**
 * GROK_HOME is the .grok directory itself. A scoped home wins over an inherited GROK_HOME,
 * which would otherwise send every account and every consult to one directory.
 */
export function grokHome(scopedHome?: string): string {
  return scopedHome ? `${scopedHome}/.grok` : process.env.GROK_HOME || `${agentHome()}/.grok`;
}

/** Resolve at spawn time, after account routing; undefined keeps the global home. */
export type AgentHomeResolver = () => string | undefined;

export function resolveAgentHome(scopedHome?: string): string {
  return scopedHome || agentHome();
}
