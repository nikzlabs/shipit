import type { AgentId, PermissionMode } from "../../shared/types.js";
import type { AgentReasoningCapability, ReviewerSlotView, RoleView } from "../../shared/types/agent-types.js";
import type { EligibleModel } from "../../shared/agent-registry.js";
import type { AccountSelectionMode, CredentialRoute, FailoverCutoffs, SessionInfo, ProjectTemplate, RepoInfo, RuntimeMode } from "../../shared/types.js";
import type { VoiceDeliveryMode } from "../../shared/types/voice-note-types.js";
import type { BillingMode } from "../../shared/catalogue/types.js";

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
  supportedPermissionModes: PermissionMode[];
  skillInvocationPrefix: string;
  reasoning?: AgentReasoningCapability;
}

export interface GlobalSettings {
  canRunTurns: boolean;
  harnessOnboardingCompletedAt?: string;
  gitIdentity: { name: string; email: string };
  systemPrompt: string;
  agents: AgentInfo[];
  // null uses the host's memory budget.
  memoryBudgetMb: number | null;
  agentSystemInstructionsEnabled: boolean;
  agentSystemInstructions: string;
  autoCreatePr: boolean;
  liveSteering: boolean;
  autoResolveConflicts: boolean;
  autoFixCi: boolean;
  // Both maps use credentialModeKey(serviceId, billingMode).
  failoverCutoffs: Record<string, FailoverCutoffs>;
  accountSelectionMode: Record<string, AccountSelectionMode>;
  autoResetMergedBranch: boolean;
  enableSubAgents: boolean;
  // Absence means follow the install; keep the stored pin separate from its resolution.
  nonTurnModel?: NonTurnModelSelection;
  nonTurnModelResolved?: NonTurnModelResolved;
  voiceDeliveryMode: VoiceDeliveryMode;
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

export interface NonTurnModelSelection {
  serviceId: string;
  billingMode: BillingMode;
  modelId: string;
}

export interface NonTurnModelResolved extends NonTurnModelSelection {
  serviceName: string;
  label: string;
  harnessId: AgentId;
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
