import type {
  IssueWriteCard as IssueWriteCardData,
  IssueRefCard as IssueRefCardData,
  CompactionCard as CompactionCardData,
  SubAgentConsultCard as SubAgentConsultCardData,
  ActionChecklistCard as ActionChecklistCardData,
  PresentInlineCard as PresentInlineCardData,
  BranchAutoResetCard as BranchAutoResetCardData,
  BranchSyncedCard as BranchSyncedCardData,
  SessionRenamedCard as SessionRenamedCardData,
  SessionSettingsChangeCard as SessionSettingsChangeCardData,
  SelfMergeWatchCard as SelfMergeWatchCardData,
  AiReviewCard,
} from "../../../server/shared/types.js";
import type { ReleaseStatusSummary } from "../../../server/shared/types/release-types.js";
import type { AgentInterfaceProvenance } from "../../../server/shared/agent-interface-sdk/protocol.js";
import type { SessionMessageOrigin } from "../../../server/shared/types.js";

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;

  bodyTruncated?: true;

  diffStats?: { added: number; removed: number };

  inputChars?: Record<string, number>;
  /**
   * ISO time the orchestrator first observed this call — shown in the tool-call
   * detail modal next to the duration. Absent on messages persisted before the
   * stamp existed, in which case the modal simply omits the time.
   */
  startedAt?: string;
}

export interface ToolResultBlock {
  toolUseId: string;
  content: string;
  isError?: boolean;

  durationMs?: number;

  truncated?: true;

  totalLines?: number;

  totalBytes?: number;
}

export type SubagentEvent =
  | {
      kind: "assistant";
      parentToolUseId: string;
      text: string;
      toolUse: ToolUseBlock[];
    }
  | {
      kind: "tool_result";
      parentToolUseId: string;
      toolResults: ToolResultBlock[];
    };

export interface ChatMessageImage {

  data?: string;
  mediaType: string;                     

  src?: string;
}

export interface ChatMessageFile {
  path: string;
  contentPreview: string;
  startLine?: number;
  endLine?: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  agentInterface?: AgentInterfaceProvenance;
  messageOrigin?: SessionMessageOrigin;

  clientRequestId?: string;
  toolUse?: ToolUseBlock[];
  toolResults?: ToolResultBlock[];
  images?: ChatMessageImage[];
  files?: ChatMessageFile[];
  streaming?: boolean;

  inProgress?: boolean;

  isError?: boolean;

  notice?: boolean;
  noticeLevel?: "info" | "warn";

  noticeId?: string;

  queued?: boolean;

  queuePosition?: number;

  pendingDispatch?: true;

  commitHash?: string;

  parentCommitHash?: string;

  uploadPaths?: string[];

  rolledBack?: boolean;
  codeRollbackHash?: string;
  forkChild?: {
    childSessionId: string;
    title: string;
    branch: string;
  };

  subagentEvents?: SubagentEvent[];
  /**
   * docs/117 Phase 2 — when set, this message renders a `SpawnedSessionCard`
   * inline in the parent's chat. Populated from `session_spawned` WS events
   * (and, eventually, from chat-history reload). The card surfaces the
   * child's title, branch, and an "Open" button that switches the active
   * session. We deliberately do not persist this in v1: the child is also
   * visible in the sidebar via the existing `session_list` broadcast, which
   * survives reload, so a missing card after refresh is not data-loss.
   */
  spawnedSession?: {
    childSessionId: string;
    title: string;
    branch?: string;
    spawnedAt: string;

    shipitFix?: {
      sourceRef: string;
      sourceExact: boolean;
      refSource?: "build-id" | "checkout-head";
      targetRepo?: string;
      diagnosis?: string;
    };
  };

  childMerged?: {
    cardId: string;
    childSessionId: string;
    childTitle: string;
    branch?: string;
    outcome: "merged" | "closed-unmerged";
    prNumber: number;
    prUrl: string;
    prTitle?: string;
    mergeSha?: string;

    deliveryFailure?: { attempts: number; error?: string };
    createdAt: string;
  };

  selfMergeWatch?: SelfMergeWatchCardData;

  sessionReport?: {
    cardId: string;
    fromSessionId: string;
    fromTitle: string;
    fromBranch?: string;
    relation: "child" | "sibling";
    severity: "fyi" | "warn" | "blocker";
    subject?: string;
    body: string;
    createdAt: string;
  };
  /**
   * docs/252 phase 7 (req 9) — when set, this message renders the dismissible
   * notice that ShipIt's non-turn work (naming this session, writing its
   * pull-request description) failed. The surrounding operation completed with
   * a fallback; this says which service broke.
   *
   * Populated from `non_turn_failure_card` WS events and from persisted
   * history. `dismissedAt` is state on the row rather than the card's absence,
   * so a dismissed notice stays in the scrollback as a quiet record instead of
   * making a recurring failure look like it never happened.
   */
  nonTurnFailure?: {
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
    dismissedAt?: string;
  };

  releaseCard?: ReleaseStatusSummary;

  spawnFailed?: {

    id?: string;
    title?: string;
    reason:
      | "quota_per_turn"
      | "quota_per_parent"
      | "invalid_request"
      | "parent_missing"
      | "error";
    message: string;
    statusCode: number;
    promptPreview?: string;

    shipitSource?: boolean;
    failedAt: string;
  };

  aiReview?: AiReviewCard;
  /**
   * docs/163 — when set, this message renders a `VoiceNoteCard` inline in the
   * chat. Populated from `voice_note` WS events. Carries only the ear-shaped
   * headline (never the turn body); the card plays it via the shared
   * playback-store keyed by the synthetic `id`.
   */
  voiceNote?: {
    id: string;
    headline: string;
    kind: "authored" | "ask" | "plan";
    createdAt: string;
  };

  userReview?: {

    filePaths: string[];

    commentCount: number;
  };

  bugReport?: {
    cardId: string;
    phase?: "draft" | "filing" | "filed" | "failed";
    title?: string;
    body?: string;
    stage2Ran?: boolean;
    producer?: "session" | "ops";
    filedAs?: string;
    createdAt?: string;
    issueNumber?: number;
    issueUrl?: string;
    errorMessage?: string;
    scopeError?: boolean;
  };

  permissionPrompt?: {
    requestId: string;
    phase?: "pending" | "approved" | "denied";
    toolName?: string;
    path?: string;
    summary?: string;
    details?: string;
    agentId?: string;
    createdAt?: string;
    remembered?: boolean;
  };

  egressPrompt?: {
    cardId: string;
    host?: string;
    phase?: "pending" | "allowed-once" | "added" | "denied";
    createdAt?: string;
  };

  issueWrite?: {
    cardId: string;
  } & Partial<IssueWriteCardData>;

  issueRef?: IssueRefCardData;

  compaction?: CompactionCardData;

  subAgentConsult?: SubAgentConsultCardData;
  /**
   * docs/207 / planning#155 — when set, this message renders an `ActionChecklistCard`
   * inline (a button for one proposed action, a checklist for 2+). The card has
   * no lifecycle and no store, so both the live `action_checklist_card` WS
   * handler and a history rehydration carry the full payload on the message; the
   * component renders straight from it. The only post-submit visual change (the
   * transient "Submitted · N sent" ack) is client-only component state, never
   * persisted — so on reload the card returns to its original definition.
   */
  actionChecklist?: ActionChecklistCardData;

  presentInline?: PresentInlineCardData;

  branchAutoReset?: BranchAutoResetCardData;

  branchSynced?: BranchSyncedCardData;

  sessionRenamed?: SessionRenamedCardData;

  sessionSettingsChange?: SessionSettingsChangeCardData;
}

export interface TextSegment {
  type: "text";
  content: string;
  offset: number;
}

export interface CodeSegment {
  type: "code";
  content: string;
  language: string;
  offset: number;
}

export type MessageSegment = TextSegment | CodeSegment;
