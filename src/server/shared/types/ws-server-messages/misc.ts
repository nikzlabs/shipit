import type { AgentId } from "../agent-types.js";
import type { EligibleModel } from "../../agent-registry.js";
import type { PermissionMode } from "../attachment-types.js";
import type { FileDiff } from "../domain-types.js";
import type { SubscriptionLimitsMap } from "../usage-limits-types.js";

export interface WsError {
  type: "error";
  message: string;
  code?: string;
  sessionId?: string;
  /** Correlates rejection with the client's optimistic user bubble. */
  requestId?: string;
}

export interface WsGlobalSettings {
  type: "global_settings";
  gitIdentity: { name: string; email: string };
  systemPrompt: string;
  agents: {
    id: AgentId;
    name: string;
    installed: boolean;
    hasRunnableModels: boolean;
    models: string[];
    eligibleModels: EligibleModel[];
    supportsReview: boolean;
    supportsSteering: boolean;
    supportedPermissionModes: PermissionMode[];
  }[];
  liveSteering: boolean;
  failoverCutoffs?: Record<string, { session: number; weekly: number }>;
  /** Keyed by agent ID; absent means strict. */
  accountSelectionMode?: Record<string, "strict" | "balanced">;
  autoResolveConflicts?: boolean;
  autoFixCi?: boolean;
  autoResetMergedBranch?: boolean;
  enableSubAgents?: boolean;
}

export interface WsTemplateApplied {
  type: "template_applied";
  templateId: string;
  name: string;
}

export interface WsTurnDiff {
  type: "turn_diff";
  fromCommit: string;
  toCommit: string;
  files: FileDiff[];
  stats: { totalInsertions: number; totalDeletions: number; filesChanged: number };
}

/** Complete SSE snapshot; replace the client's map. */
export interface WsSubscriptionLimits {
  type: "subscription_limits";
  limits: SubscriptionLimitsMap;
}
