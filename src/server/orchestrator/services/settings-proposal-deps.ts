import type { AgentRegistry } from "../../shared/agent-registry.js";
import type { EgressEnforcementStatus } from "../../shared/types.js";
import type { AgentMergeClaimStore } from "../agent-merge-claims.js";
import type { ChatHistoryManager } from "../chat-history.js";
import type { CredentialStore } from "../credential-store.js";
import type { EgressAllowlistStore } from "../egress-allowlist-store.js";
import {
  egressEnforcementActive,
  egressEnforcementStatus,
} from "../egress-firewall-install.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import type { RepoStore } from "../repo-store.js";
import type { SecretStore } from "../secret-store.js";
import type { ServiceManager } from "../service-manager.js";
import type { SessionManager } from "../sessions.js";
import type { SessionContainerManager } from "../session-container.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { SettingsProposalStore } from "../settings-proposal-store.js";
import type { SettingsDecisionDeps } from "./settings-decision.js";
import type { SettingsProposeDeps } from "./settings-propose.js";

/**
 * One place the proposal path's dependencies are assembled
 * (docs/299-agent-settings-access req 4).
 *
 * The two callers see the same stores under different names — `propose` arrives
 * over HTTP with `ApiDeps`, a decision arrives over the WebSocket with the
 * connection context — and both have to reach the same stores, or a card could
 * be written against one view of the install and applied against another. So the
 * assembly lives here rather than at either call site.
 *
 * Where an install genuinely lacks the proposal store, both builders answer
 * `null` and the caller says so. That is the one state worth degrading for: every
 * other store is optional per entry inside the read and the apply themselves.
 */

export interface SettingsProposalSource {
  sseBroadcast: (event: string, data: unknown) => void;
  workspaceDir: string;
  agentRegistry: AgentRegistry;
  sessionManager: SessionManager;
  chatHistoryManager: ChatHistoryManager;
  settingsProposals?: SettingsProposalStore | undefined;
  credentialStore?: CredentialStore | undefined;
  providerAccountManager?: ProviderAccountManager | undefined;
  egressAllowlistStore?: EgressAllowlistStore | undefined;
  repoStore?: RepoStore | undefined;
  secretStore?: SecretStore | undefined;
  containerManager?: SessionContainerManager | undefined;
  serviceManagers?: Map<string, ServiceManager> | undefined;
  agentMergeClaims?: AgentMergeClaimStore | undefined;
  prStatusPoller?: { broadcastAllSnapshots(): void } | undefined;
  /** Supplied by the HTTP deps; the WebSocket context reads the environment. */
  egressEnforcementStatus?: EgressEnforcementStatus | undefined;
  egressEnforcementActive?: boolean | undefined;
  runnerRegistry?: SessionRunnerRegistry | undefined;
  getRunnerRegistry?: (() => SessionRunnerRegistry | undefined) | undefined;
}

function assemble(src: SettingsProposalSource, proposals: SettingsProposalStore) {
  const registry = src.runnerRegistry;
  return {
    proposals,
    chatHistoryManager: src.chatHistoryManager,
    getRunnerRegistry: src.getRunnerRegistry ?? (() => registry),
    read: {
      agentRegistry: src.agentRegistry,
      appWorkspaceDir: src.workspaceDir,
      sessionManager: src.sessionManager,
      credentialStore: src.credentialStore,
      providerAccountManager: src.providerAccountManager,
      egressAllowlistStore: src.egressAllowlistStore,
      repoStore: src.repoStore,
      secretStore: src.secretStore,
      containerManager: src.containerManager,
      egressEnforcementStatus: src.egressEnforcementStatus ?? egressEnforcementStatus(),
      egressEnforcementActive: src.egressEnforcementActive ?? egressEnforcementActive(),
      proposals,
    },
    baseline: {
      appWorkspaceDir: src.workspaceDir,
      credentialStore: src.credentialStore,
      egressAllowlistStore: src.egressAllowlistStore,
      repoStore: src.repoStore,
    },
    operations: {
      sseBroadcast: src.sseBroadcast,
      appWorkspaceDir: src.workspaceDir,
      agentRegistry: src.agentRegistry,
      credentialStore: src.credentialStore,
      providerAccountManager: src.providerAccountManager,
      egressAllowlistStore: src.egressAllowlistStore,
      repoStore: src.repoStore,
      chatHistoryManager: src.chatHistoryManager,
      runnerRegistry: src.getRunnerRegistry?.() ?? registry,
      agentMergeClaims: src.agentMergeClaims,
      serviceManagers: src.serviceManagers,
      containerManager: src.containerManager,
      prStatusPoller: src.prStatusPoller,
    },
  };
}

/**
 * Everything both halves need. One builder rather than two, because a propose
 * and the decision that applies it have to resolve the same stores: the card is
 * written against this view and applied against it.
 */
export function settingsProposalDeps(
  src: SettingsProposalSource,
): (SettingsProposeDeps & SettingsDecisionDeps) | null {
  return src.settingsProposals ? assemble(src, src.settingsProposals) : null;
}
