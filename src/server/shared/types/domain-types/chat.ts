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
  /**
   * When the server accepted a submission composed from this card. Records that
   * the user acted, so docs/299 can collapse the card with the rest of its turn;
   * it locks nothing, so the card above stays a reusable composer.
   */
  submittedAt?: string;
}

/**
 * Whether a saved setting is what ShipIt actually uses. The same four answers
 * the read surface gives (`services/settings-read.ts` → `SettingEffectState`),
 * so a card and a read say the same thing about the same write: "saved, applies
 * after a restart" is a false promise for a sandbox whose containment is already
 * fixed, which is the case the user is usually unblocking.
 */
export type SettingsEffectState = "live" | "restart-dependent" | "excluded" | "uncertain";

/**
 * What a proposal is about. A declaration key alone does not name one value:
 * `project.allowAgentMerge` exists once per repository and `mcp.servers[].enabled`
 * once per server (docs/299-agent-settings-access plan.md → The target, and the
 * lock). The repository is frozen when the card is written, and apply verifies
 * the session still binds it.
 */
export interface SettingsProposalTarget {
  key: string;
  /** A per-repository setting's repository, as the session bound it at propose time. */
  repoUrl?: string;
  /** One instance of an item-addressed setting — a role name, an MCP server. */
  item?: string;
}

/**
 * `pending` → `dismissed`, or `pending` → `applying` → one terminal answer.
 *
 * The terminal set is deliberately wider than applied/failed: three shipped
 * writers cannot prove what they did (`CredentialStore.save` logs and returns
 * void, `setGitIdentity` is two `git config` calls, `writeGlobalSystemPrompt`
 * swallows its unlink error), so `failed` is reserved for a writer that verified
 * nothing changed, `partial` for a multi-write operation that half landed, and
 * `uncertain` for a writer that cannot say. `unknown` is a card found mid-apply
 * after a restart: it is never retried, because the side effect may already have
 * run.
 */
export type SettingsProposalPhase =
  | "pending"
  | "applying"
  | "applied"
  | "partial"
  | "uncertain"
  | "stale"
  | "refused"
  | "failed"
  | "dismissed"
  | "unknown";

/**
 * One proposed settings change, as it appears in the transcript
 * (docs/299-agent-settings-access req 4). One card carries one change, and the
 * setting does not move until the user clicks.
 *
 * Everything describing the change is ShipIt's own: `label`, `description` and
 * `path` are the registry's words and `from`/`to` come from the server's own
 * read, both snapshotted at propose time so a later rename cannot rewrite
 * history. `reason` is the ONLY agent-authored field — untrusted text, flattened
 * and capped before it is stored, and rendered as attributed. That separation is
 * what stops a reason describing a different change than the button applies.
 *
 * The baseline apply compares against is deliberately NOT here: transcript
 * projection returns a message's fields unless something strips them, so it
 * lives in the private proposal row instead (`settings-proposal-store.ts`).
 */
export interface SettingsProposalCard {
  cardId: string;
  target: SettingsProposalTarget;
  /** The declared label, snapshotted. */
  label: string;
  /** The declared description — the same words the dialog shows. */
  description: string;
  /** Breadcrumb to the control, e.g. `Settings › Advanced`. */
  path: string;
  /** The current value at propose time, formatted by the catalogue's own door. */
  from: string;
  /** The proposed value, formatted the same way. */
  to: string;
  /** The agent's words, flattened to one line and capped. */
  reason?: string;
  phase: SettingsProposalPhase;
  createdAt: string;
  resolvedAt?: string;
  /**
   * ShipIt's own account of a terminal phase, never the agent's words:
   * `outcome` replaces the phase's standard clause ("added `registry.npmjs.org`
   * to the global allowlist"), `outcomeDetail` is the line under it ("the name
   * was saved, the email failed").
   */
  outcome?: string;
  outcomeDetail?: string;
  /** Present once applied: whether the saved value is what ShipIt now uses. */
  effect?: { state: SettingsEffectState; detail?: string };
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
        /** ISO time the orchestrator first saw the call; absent on older rows. */
        startedAt?: string;
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
    /** ISO time the orchestrator first saw the call; absent on older rows. */
    startedAt?: string;
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
