import type { AgentId } from "../agent-types.js";
import type { BillingMode } from "../../catalogue/types.js";

export interface SessionMessageOrigin {
  sessionId: string;
  sessionTitle: string;
  relation: "parent" | "child" | "sibling";
}

export interface CompactionCard {
  id: string;
  trigger?: "manual" | "auto";
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
  createdAt: string;
}

export interface SubAgentRunTarget {
  serviceId: string;
  billingMode: BillingMode;
  modelId: string;
  /** Absent means no flag was passed; do not infer the harness's default level. */
  reasoningEffort?: string;
}

/** Persist pending at spawn, then patch to terminal status; transient activity cannot replace this. */
export interface SubAgentConsultCard {
  cardId: string;
  spawnId: string;
  subAgentId: AgentId;
  /** Captured at admission, shared by execution, retries, and usage; absent only on legacy rows. */
  runOn?: SubAgentRunTarget;
  roleName?: string;
  status: "pending" | "success" | "error" | "timeout" | "cancelled";
  /** ShipIt's explanation, including every cancellation cause; never mix into the agent's output. */
  statusDetail?: string;
  durationMs?: number;
  costUsd?: number;
  truncated?: boolean;
  outputMarkdown?: string;
  /** Serve-only preview flag; persisted output remains complete. */
  outputTruncated?: true;
  createdAt: string;
  /** Present only if ShipIt attempted a result wake; absence does not mean delivery failed. */
  wakeDelivery?: {
    at: string;
    outcome: "queued" | "delivered" | "failed";
    detail?: string;
  };
}

export interface ActionChecklistItem {
  id: string;
  label: string;
  description?: string;
  defaultChecked?: boolean;
  /** Self-contained instruction: the card can outlive the turn and container. */
  payload: string;
}

/** Metadata only; content is read from disk on demand, so re-presenting updates the artifact. */
export interface PresentInlineCard {
  presentId: string;
  filePath: string;
  mimeType: string;
  title?: string;
  createdAt: string;
}

/** Immutable, reusable message composer; submitting actions does not lock the card. */
export interface ActionChecklistCard {
  cardId: string;
  title?: string;
  actions: ActionChecklistItem[];
  branch?: string;
  headSha?: string;
  createdAt: string;
}

export interface BranchAutoResetCard {
  cardId: string;
  base: string;
  prNumber: number;
  prUrl: string;
  fromSha: string;
  toSha: string;
  createdAt: string;
  /** Records bypass of the merged-head equality gate. */
  forced?: boolean;
  /** Required when forced is true. */
  forceReason?: string;
}

export interface BranchSyncedCard {
  cardId: string;
  base: string;
  headFromSha: string;
  headToSha: string;
  baseFromSha: string | null;
  baseToSha: string;
  forcePushed: boolean;
  createdAt: string;
}

export interface SessionRenamedCard {
  cardId: string;
  from: string;
  to: string;
  createdAt: string;
}

/** Snapshot user-facing labels; later renaming must not rewrite history. */
export interface SessionSettingsChangeEntry {
  label: string;
  from: string;
  to: string;
  /** Only for binary grants; absent for three-state inheritance settings. */
  granted?: boolean;
}

export interface SessionSettingsChangeCard {
  cardId: string;
  scope: "sandbox-capabilities" | "network-mode";
  changes: SessionSettingsChangeEntry[];
  /** Snapshot at emit time, not live restart status. */
  pendingRestart: boolean;
  createdAt: string;
}

export type WsSubagentEvent =
  | {
      kind: "assistant";
      parentToolUseId: string;
      text: string;
      toolUse: {
        type: "tool_use";
        id: string;
        name: string;
        input: Record<string, unknown>;
      }[];
    }
  | {
      kind: "tool_result";
      parentToolUseId: string;
      toolResults: {
        toolUseId: string;
        content: string;
        isError?: boolean;
      }[];
    };

export interface WsChatHistoryMessage {
  role: "user" | "assistant";
  text: string;
  toolUse?: {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
  }[];
  images?: {
    /** Stored base64 is replaced by src on the serve path. */
    data?: string;
    mediaType: string;
    src?: string;
  }[];
  files?: {
    path: string;
    contentPreview: string;
    startLine?: number;
    endLine?: number;
  }[];
  isError?: boolean;
  toolResults?: {
    toolUseId: string;
    content: string;
    isError?: boolean;
  }[];
  inProgress?: boolean;
  commitHash?: string;
  parentCommitHash?: string;
  uploadPaths?: string[];
  notice?: boolean;
  noticeLevel?: "info" | "warn";
  rolledBack?: boolean;
  forkChild?: { childSessionId: string; title: string; branch: string };
  codeRollbackHash?: string;
  subagentEvents?: WsSubagentEvent[];
}
