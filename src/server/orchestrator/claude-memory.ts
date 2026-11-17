import type { AgentId } from "../shared/types.js";
import type { CredentialStore } from "./credential-store.js";

// Only harnesses whose memory ShipIt can switch off.
const AUTO_MEMORY_SETTINGS = {
  claude: "advanced.claudeMemory",
} as const;

/** False only for a spawn whose memory setting is off; undefined leaves the CLI's default. */
export function autoMemoryFor(
  agentId: AgentId,
  store: Pick<CredentialStore, "getDeclaredSetting"> | undefined,
): false | undefined {
  if (!store || !Object.hasOwn(AUTO_MEMORY_SETTINGS, agentId)) return undefined;
  const key = AUTO_MEMORY_SETTINGS[agentId as keyof typeof AUTO_MEMORY_SETTINGS];
  return store.getDeclaredSetting(key) ? undefined : false;
}

// A resident process holds the value it was spawned with, so a change must retire it.
// Marked only when off, so a process spawned before this setting existed is kept.
export function withAutoMemory(identity: string | undefined, autoMemory: boolean | undefined): string | undefined {
  return identity !== undefined && autoMemory === false ? `${identity}|nomemory` : identity;
}
