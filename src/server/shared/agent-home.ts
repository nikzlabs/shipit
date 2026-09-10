export const DEFAULT_AGENT_HOME = "/home/shipit";

// Resolve at call time: local mode and session containers use different homes.
export function agentHome(): string {
  return process.env.AGENT_HOME || DEFAULT_AGENT_HOME;
}

export function codexHome(): string {
  return process.env.CODEX_HOME || `${agentHome()}/.codex`;
}

/** GROK_HOME is the .grok directory itself. Use the spawn's account-scoped home. */
export function grokHome(home: string): string {
  return process.env.GROK_HOME || `${home}/.grok`;
}

/** Resolve at spawn time, after account routing; undefined keeps the global home. */
export type AgentHomeResolver = () => string | undefined;

export function resolveAgentHome(scopedHome?: string): string {
  return scopedHome || agentHome();
}
