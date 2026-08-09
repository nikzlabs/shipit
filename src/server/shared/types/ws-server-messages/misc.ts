import type { AgentId, SubAgentDefaults } from "../agent-types.js";
import type { EligibleModel } from "../../agent-registry.js";
import type { PermissionMode } from "../attachment-types.js";
import type { FileDiff } from "../domain-types.js";
import type { SubscriptionLimitsMap } from "../usage-limits-types.js";

export interface WsError {
  type: "error";
  message: string;
  /** Stable machine-readable code for actionable transport errors. */
  code?: string;
  /** Authoritative owning session when the error is session-scoped. */
  sessionId?: string;
  /** Correlates rejection with the client's optimistic user bubble. */
  requestId?: string;
}

// ---- Global settings messages ----

/** Bundled response containing all global settings. */
export interface WsGlobalSettings {
  type: "global_settings";
  gitIdentity: { name: string; email: string };
  systemPrompt: string;
  agents: {
    id: AgentId;
    name: string;
    installed: boolean;
    authConfigured: boolean;
    models: string[];
    /**
     * docs/252 phase 3 (req 8) — the models this install can run on this
     * harness, each as its `(service, billing mode, model)` triple. The picker
     * reads this; `models` above is the same list's ids.
     */
    eligibleModels: EligibleModel[];
    /**
     * Whether the agent backend can run the chat-native AI review flow
     * (docs/125-chat-native-ai-review). Drives whether the "Ask agent to
     * review" button shows up in the file-preview modal.
     */
    supportsReview: boolean;
    /**
     * Whether this agent supports live steering (docs/140) — injecting user
     * messages into a running turn without queuing.
     */
    supportsSteering: boolean;
    /**
     * Permission modes this agent supports (docs/138). Drives the client's
     * agent-aware mode selector — e.g. `guarded` is only offered when this
     * array includes it. Codex reports `[]` (no permission modes).
     */
    supportedPermissionModes: PermissionMode[];
  }[];
  /** When true, mid-turn messages steer the running agent. (docs/140) */
  liveSteering: boolean;
  /**
   * docs/150 reqs 4-6 — per-provider proactive failover cutoffs, keyed by agent
   * id. Optional so an older orchestrator's payload still parses.
   */
  failoverCutoffs?: Record<string, { session: number; weekly: number }>;
  /**
   * docs/150 req 21 — per-provider account selection mode, keyed by agent id.
   * Optional for the same reason as the cutoffs above: an older orchestrator's
   * payload must still parse, and its absence means "strict".
   */
  accountSelectionMode?: Record<string, "strict" | "balanced">;
  /** docs/146 — global gate for the auto-resolve-conflicts loop. */
  autoResolveConflicts?: boolean;
  /** docs/169 — global gate for the auto-fix-CI loop. */
  autoFixCi?: boolean;
  /** docs/218 — global gate for auto-resetting a merged session's branch on continue. */
  autoResetMergedBranch?: boolean;
  /** docs/144 — global gate for sub-agent spawning. */
  enableSubAgents?: boolean;
  /** docs/217 — per-agent sub-agent defaults (Control A), keyed by agent id. */
  agentSubAgentDefaults?: Record<string, SubAgentDefaults>;
}

// ---- Template messages ----

export interface WsTemplateApplied {
  type: "template_applied";
  templateId: string;
  name: string;
}

// ---- Diff review messages (server → client) ----

export interface WsTurnDiff {
  type: "turn_diff";
  fromCommit: string;
  toCommit: string;
  files: FileDiff[];
  stats: { totalInsertions: number; totalDeletions: number; filesChanged: number };
}

// ---- Subscription limits ----

/**
 * Server → Client (SSE only): account-wide subscription rate-limit
 * snapshots per agent. Sent on `/api/events` initial connect and
 * whenever any provider's snapshot changes (success → success delta,
 * success → error transition, sign-out → key removed).
 *
 * The payload is a complete map — providers missing from `limits`
 * have either no provider registered, `canFetch() === false`, or have
 * been signed out. The client replaces its store map wholesale.
 *
 * See docs/135-subscription-limits-badge/plan.md.
 */
export interface WsSubscriptionLimits {
  type: "subscription_limits";
  limits: SubscriptionLimitsMap;
}
