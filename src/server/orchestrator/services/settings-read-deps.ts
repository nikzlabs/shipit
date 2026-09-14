import type { AgentRegistry } from "../../shared/agent-registry.js";
import type { EgressEnforcementStatus, SettingsProposalTarget } from "../../shared/types.js";
import type { SettingsProposalRow } from "../settings-proposal-store.js";
import type { CredentialStore } from "../credential-store.js";
import type { EgressAllowlistStore } from "../egress-allowlist-store.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import type { SessionManager } from "../sessions.js";

/**
 * What the agent's settings read needs to reach every store a setting lives in
 * (docs/299-agent-settings-access). It sits in its own module because both
 * `settings-read.ts` and the per-owner readers it drives take it.
 *
 * Every store is optional: a read degrades per entry, so an install without one
 * of them still answers for every other setting.
 */
export interface SettingsReadDeps {
  agentRegistry: Pick<AgentRegistry, "list">;
  appWorkspaceDir: string;
  sessionManager: Pick<SessionManager, "get">;
  credentialStore?: CredentialStore | undefined;
  providerAccountManager?: ProviderAccountManager | undefined;
  egressAllowlistStore?: EgressAllowlistStore | undefined;
  /** Per-repository settings; the repository is the session's own binding. */
  repoStore?: { get(url: string): { allowAgentMerge?: boolean; colorIndex?: number } | undefined } | undefined;
  secretStore?: {
    loadSecretNames(repoUrl: string): string[];
    loadSecrets(repoUrl: string): Record<string, string>;
  } | undefined;
  egressEnforcementStatus?: EgressEnforcementStatus | undefined;
  egressEnforcementActive?: boolean | undefined;
  containerManager?: {
    get(sessionId: string): { status?: string; egressContainedAtStart?: boolean } | undefined;
    /** The shipped resolver, so sandbox capabilities are honoured, not re-derived. */
    resolveEgress(sessionId: string): { contained: boolean; userHostsExcluded?: boolean } | undefined;
    /**
     * The capabilities the RUNNING container started with — null when none is
     * running and for one rediscovered after a ShipIt restart, which recorded
     * none. `resolveEgress` answers for the NEXT start, so a probe that has to
     * say what is in force reads this instead (`settings-read.ts` →
     * `startedUserHostsExcluded`). Required rather than optional: an effect
     * answer sourced from the wrong one of the two is the failure req 3 exists
     * to prevent, so a caller cannot leave it out.
     */
    capabilitiesAtStart(sessionId: string): { network: boolean } | null;
  } | undefined;
  /** Injected by tests; the release channel otherwise comes off the host checkout. */
  readReleaseChannel?: (() => Promise<string>) | undefined;
  /**
   * The last proposal about a setting, which `get` reports so the agent knows
   * what the user already did about it (docs/299 req 8). Optional: an install
   * without the store answers every setting, minus that one fact.
   */
  proposals?: {
    latestForTarget(target: SettingsProposalTarget): SettingsProposalRow | null;
    latestForKey(key: string, repoUrl?: string): SettingsProposalRow | null;
  } | undefined;
}
