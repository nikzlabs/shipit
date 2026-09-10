import type { AgentId } from "../agent-types.js";
import type { ProviderRouteKind } from "./provider.js";
import type { BillingMode } from "../../catalogue/types.js";
import type { SecretFinding } from "../../secret-scan.js";

/** Server-authoritative grants; never infer them from agent-writable workspace files. */
export interface SessionCapabilities {
  /** Credential broker access, not a network seal. */
  git: boolean;
  /** Session-scoped Docker, never the host socket. */
  docker: boolean;
  /** False tightens egress to lifelines; true retains normal containment. */
  network: boolean;
  dangerousGitHubOps: boolean;
}

export const DEFAULT_SANDBOX_CAPABILITIES: SessionCapabilities = {
  git: false,
  docker: false,
  network: true,
  dangerousGitHubOps: false,
};

export function normalizeCapabilities(input: unknown): SessionCapabilities {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const flag = (key: keyof SessionCapabilities): boolean => {
    const v = obj[key];
    return typeof v === "boolean" ? v : DEFAULT_SANDBOX_CAPABILITIES[key];
  };
  const git = flag("git");
  return {
    git,
    docker: flag("docker"),
    network: flag("network"),
    dangerousGitHubOps: git && flag("dangerousGitHubOps"),
  };
}

export interface SandboxCapabilitiesView {
  sessionId: string;
  capabilities: SessionCapabilities;
  /** Null for absent or rediscovered containers with unknown startup grants. */
  capabilitiesAtStart: SessionCapabilities | null;
  pendingRestart: boolean;
}

/** User titles are final; agent titles block the automatic namer. Absent means replaceable. */
export type SessionTitleSource = "user" | "agent";

export interface SessionInfo {
  id: string;
  agentSessionId?: string;
  title: string;
  titleSource?: SessionTitleSource;
  kind?: "ops" | "sandbox";
  capabilities?: SessionCapabilities;
  createdAt: string;
  lastUsedAt: string;
  workspaceDir?: string;
  remoteUrl: string;
  /** Read-only legacy alias of userArchived. */
  archived?: boolean;
  diskTier?: "hot" | "light" | "evicted";
  userArchived?: boolean;
  /** Disk-idle clock only; viewing must not promote a resolved session to Active. */
  lastViewedAt?: string;
  /** Protects sidebar and disk persistence, not live capacity. */
  pinnedAt?: string;
  keepPreviewRunning?: boolean;
  /** Cleared at the start of the next turn, regardless of its source. */
  mutedAt?: string;
  branch?: string;
  warm?: boolean;
  branchRenamed?: boolean;
  conversationReplay?: string;
  mergedAt?: string;
  closedAt?: string;
  model?: string;
  reasoningEffort?: string;
  agentId?: AgentId;
  agentPinned?: boolean;
  serviceId?: string;
  billingMode?: BillingMode;
  // Clear all four route fields when selection crosses a service or billing mode.
  providerRouteKind?: ProviderRouteKind;
  providerRouteId?: string;
  providerRouteServiceId?: string;
  providerRouteBillingMode?: BillingMode;
  parentSessionId?: string;
  spawnedByTurn?: string;
  /** Immutable creation snapshot, not a live role reference. */
  originRoleName?: string;
  /** Active role, cleared on manual control changes; never inferred from matching parameters. */
  roleName?: string;
  rootSessionId?: string;
  lastTurnErrored?: boolean;
  autoFixCiPaused?: boolean;
  mergeWatch?: SessionMergeWatch;
  secretBlock?: SessionSecretBlock;
  /** Must not affect resolved status, sidebar grouping, or disk eviction. */
  previousMergedPr?: PreviousMergedPr;
  /** PR head.sha, never local HEAD at detection; reset fails closed if missing. */
  mergedHeadSha?: string;
  /** Durable, last-write-wins notice consumed atomically by the next interactive turn. */
  pendingAgentNotice?: string;
  /** Pair witnessed by ShipIt opening the PR; never derive from general PR status. */
  prNumber?: number;
  prRepoId?: string;
}

export interface PreviousMergedPr {
  number: number;
  url: string;
  title: string;
  baseBranch: string;
  /** Retains the PR's head.sha across re-arm; never refresh from local HEAD. */
  mergedHeadSha?: string;
}

export interface SessionSecretBlock {
  /** Already redacted by the detector. */
  findings: SecretFinding[];
  at: string;
  /** Bounds remediation so a persistent secret cannot cause endless agent turns. */
  notifyCount: number;
}

export interface SessionMergeWatch {
  parentSessionId: string;
  kind?: "self";
  /** Check every settlement/cancel against this arming so stale events cannot settle a new watch. */
  watchId?: string;
  prNumber?: number;
  state: "armed" | "merge-observed" | "delivered" | "closed-unmerged" | "delivery-failed";
  registeredAt: string;
  observedAt?: string;
  deliveredAt?: string;
  deliveryAttempts?: number;
  lastAttemptAt?: string;
  /** Worker-visible watchId:attempt; reconnect adoption uses it to avoid duplicate wakes. */
  deliveryId?: string;
  lastDeliveryError?: string;
  failedAt?: string;
}

export interface ChildMergedCard {
  cardId: string;
  childSessionId: string;
  childTitle: string;
  branch?: string;
  outcome: "merged" | "closed-unmerged";
  prNumber: number;
  prUrl: string;
  prTitle?: string;
  mergeSha?: string;
  deliveryFailure?: {
    attempts: number;
    error?: string;
  };
  createdAt: string;
}

export interface SelfMergeWatchCard {
  cardId: string;
  watchId: string;
  prNumber: number;
  prUrl: string;
  prTitle?: string;
  branch?: string;
  createdAt: string;
}

export type SessionReportSeverity = "fyi" | "warn" | "blocker";

export interface SessionReportCard {
  cardId: string;
  fromSessionId: string;
  fromTitle: string;
  fromBranch?: string;
  /** Sibling is a legacy persisted value; current reports come from children. */
  relation: "child" | "sibling";
  severity: SessionReportSeverity;
  subject?: string;
  body: string;
  createdAt: string;
}

export interface RepoInfo {
  url: string;
  addedAt: string;
  lastUsedAt: string;
  status: "cloning" | "ready";
  warmSessionId?: string;
  /** Gates repo-declared install/Compose execution, not clone, reads, or chat. */
  trusted?: boolean;
  /** Browser-only grant; never derive from agent-writable repository content. */
  allowAgentMerge?: boolean;
  hidden?: boolean;
  defaultBranch?: string;
  colorIndex?: number;
}

export interface NonTurnFailureCard {
  cardId: string;
  purpose: "session-naming" | "pr-description";
  serviceId?: string;
  serviceName?: string;
  billingMode?: "sub" | "key";
  modelId?: string;
  pinned?: boolean;
  fallback: string;
  detail?: string;
  createdAt: string;
  /** Dismissal keeps the row as a record of the failure. */
  dismissedAt?: string;
}
