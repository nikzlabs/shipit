import type { AgentId, PermissionMode } from "../../shared/types.js";
import type { AgentCapabilities, AgentReasoningCapability, ReviewerSlotView, RoleView } from "../../shared/types/agent-types.js";
import type { EligibleModel } from "../../shared/agent-registry.js";
import type { AccountSelectionMode, CredentialRoute, FailoverCutoffs, SessionInfo, ProjectTemplate, RepoInfo, RuntimeMode } from "../../shared/types.js";
import type { StoredGlobalSettings } from "../../shared/settings-catalogue/index.js";
import type { ModelSelection } from "../../shared/catalogue/types.js";

export interface AgentInfo {
  id: AgentId;
  name: string;
  installed: boolean;
  hasRunnableModels: boolean;
  models: string[];
  eligibleModels: EligibleModel[];
  supportsReview: boolean;
  supportsSteering: boolean;
  supportsCompaction: boolean;
  supportsGoals: boolean;
  goalActions?: AgentCapabilities["goalActions"];
  supportedPermissionModes: PermissionMode[];
  skillInvocationPrefix: string;
  reasoning?: AgentReasoningCapability;
}

/**
 * The stored half derives from the settings catalogue, so a declared setting
 * reaches the payload with no edit here (docs/299-agent-settings-access req 7).
 * The computed half — status nobody can edit — stays hand-assembled beside it.
 */
export interface GlobalSettings extends StoredGlobalSettings {
  canRunTurns: boolean;
  harnessOnboardingCompletedAt?: string;
  agents: AgentInfo[];
  /** Displayed content; the setting beside it is the toggle that enables it. */
  agentSystemInstructions: string;
  // Both maps use credentialModeKey(serviceId, billingMode).
  failoverCutoffs: Record<string, FailoverCutoffs>;
  accountSelectionMode: Record<string, AccountSelectionMode>;
  // Keep the stored pin separate from its resolution.
  nonTurnModelResolved?: NonTurnModelResolved;
  /**
   * docs/299 req 3 — what the background-work selector may offer, which is NOT
   * the union of the installed harnesses' `eligibleModels`: a model provider
   * reachable only by a direct call belongs here and appears in no harness.
   */
  backgroundWorkModels: EligibleModel[];
  voiceWebhookConfigured: boolean;
  providerAccounts: CredentialRoute[];
  credentialRoutes: CredentialRoute[];
  reviewers: ReviewerSlotView[];
  roles: RoleView[];
}

export type { ReviewerPinPatch, ReviewerResolved, ReviewerSlotView } from "../../shared/types/agent-types.js";

export type {
  AgentRole,
  RoleParams,
  RoleResolved,
  RoleUnavailableReason,
  RoleView,
} from "../../shared/types/agent-types.js";

export type NonTurnModelSelection = ModelSelection;

export interface NonTurnModelResolved extends NonTurnModelSelection {
  serviceName: string;
  label: string;
  /**
   * Absent where the work runs as a direct provider call — no harness, no
   * container (docs/299 req 2). `execution` says which, so the client never has
   * to read an absence as a state.
   */
  harnessId?: AgentId;
  execution: "harness" | "direct";
  source: "pinned" | "default";
}

export interface GitHubStatus {
  authenticated: boolean;
  username?: string;
  avatarUrl?: string;
}

export interface BootstrapData {
  sessions: SessionInfo[];
  repos: RepoInfo[];
  agents: AgentInfo[];
  templates: Omit<ProjectTemplate, "files">[];
  githubStatus: GitHubStatus;
  settings: GlobalSettings;
  runtimeMode: RuntimeMode;
  tailnetPreviewHost?: string;
}

export class ServiceError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}
