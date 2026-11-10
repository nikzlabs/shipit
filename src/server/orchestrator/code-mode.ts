import type { AgentId } from "../shared/types.js";
import type { CredentialStore } from "./credential-store.js";

// docs/341-code-mode-setting req 2: only harnesses whose Code Mode runs in ShipIt.
const CODE_MODE_SETTINGS = {
  opencode2: "advanced.codeMode.opencode2",
  codex: "advanced.codeMode.codex",
  opencode: "advanced.codeMode.opencode",
} as const;

/** Undefined for a harness with no Code Mode setting. */
export function codeModeFor(
  agentId: AgentId,
  store: Pick<CredentialStore, "getDeclaredSetting"> | undefined,
): boolean | undefined {
  if (!store || !Object.hasOwn(CODE_MODE_SETTINGS, agentId)) return undefined;
  return store.getDeclaredSetting(CODE_MODE_SETTINGS[agentId as keyof typeof CODE_MODE_SETTINGS]);
}

// A resident process holds the value it was spawned with, so a change must retire it
// (req 6). Marked only when on, so a process spawned before this setting existed is kept.
export function withCodeMode(identity: string | undefined, codeMode: boolean | undefined): string | undefined {
  return identity !== undefined && codeMode === true ? `${identity}|codemode` : identity;
}
