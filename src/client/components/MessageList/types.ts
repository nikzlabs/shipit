import type {
  IssueWriteCard as IssueWriteCardData,
  IssueRefCard as IssueRefCardData,
  CompactionCard as CompactionCardData,
  SubAgentConsultCard as SubAgentConsultCardData,
  ActionChecklistCard as ActionChecklistCardData,
  BranchAutoResetCard as BranchAutoResetCardData,
  BranchSyncedCard as BranchSyncedCardData,
  AiReviewCard,
} from "../../../server/shared/types.js";
import type { ReleaseStatusSummary } from "../../../server/shared/types/release-types.js";

// ── Type exports (kept here as the canonical location for backward compat) ──

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  toolUseId: string;
  content: string;
  isError?: boolean;
  /**
   * Derived per-tool execution time in ms (docs/185), computed server-side as
   * the delta between the tool_use and its tool_result. Shown in the tool-call
   * detail modal. Absent on older persisted messages and tools with no recorded
   * start.
   */
  durationMs?: number;
}

/**
 * A single nested event emitted by a subagent (Claude's Task tool). Each entry
 * carries `parentToolUseId` linking it back to a tool_use block in the parent
 * message's `toolUse` list. Used for subagent transparency (109).
 */
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
  data: string;      // base64-encoded image data
  mediaType: string; // "image/png", etc.
  /** Optional pre-built src URL (e.g. blob: URL for optimistic messages). When set, used directly instead of building a data: URI from data+mediaType. */
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
  toolUse?: ToolUseBlock[];
  toolResults?: ToolResultBlock[];
  images?: ChatMessageImage[];
  files?: ChatMessageFile[];
  streaming?: boolean;
  /** When true, this message represents an error (CLI crash, WS drop, etc.) */
  isError?: boolean;
  /**
   * When true, this is an informational system note (docs/138) — e.g. a
   * guarded-mode fallback or a summary of classifier-blocked actions. Rendered
   * as a muted, full-width inline note, distinct from both normal assistant
   * text and the red error style. `noticeLevel` tints warnings.
   */
  notice?: boolean;
  noticeLevel?: "info" | "warn";
  /**
   * docs/138 — stable id for a persisted system notice, used to dedupe a notice
   * re-delivered by the turn-event buffer replay on reconnect against the copy
   * rehydrated from history. Absent on the transient rewind action-feedback
   * notices, which are emit-only by design.
   */
  noticeId?: string;
  /** When true, this message is queued and waiting for Claude to become available. */
  queued?: boolean;
  /** 1-indexed position in the queue, shown as a badge. */
  queuePosition?: number;
  /**
   * docs/150 — set on optimistic user bubbles created by the HTTP dispatch
   * helper (Create PR, Send compose error, etc.). When the matching
   * `system_user_message` echo arrives over the WS, the handler dedupes by
   * clearing this flag in place instead of appending a duplicate bubble.
   * Survives a tab reload via the normal optimistic-state lifecycle (the
   * dispatch completes before reload anyway; this flag is only meaningful
   * within the same session).
   */
  pendingDispatch?: true;
  /** Git commit hash produced by auto-commit after this assistant message. */
  commitHash?: string;
  /** Parent commit hash (HEAD before the auto-commit). Used for rollback. */
  parentCommitHash?: string;
  /** Upload paths consumed by this message (for hydration of pending vs sent state). */
  uploadPaths?: string[];
  /** When true, this message was rolled back and should appear dimmed. */
  rolledBack?: boolean;
  codeRollbackHash?: string;
  forkChild?: {
    childSessionId: string;
    title: string;
    branch: string;
  };
  /**
   * Events emitted by subagents (Claude's Task tool) under any tool in this
   * message's `toolUse`. The renderer groups these by `parentToolUseId` and
   * displays them as a nested tree under the parent Task call (109).
   */
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
    /**
     * docs/162 — present only for Ops `--shipit-source` fix-session spawns;
     * renders the card's "ShipIt fix" variant (source ref, target repo,
     * diagnosis summary). Absent for ordinary fan-out spawns.
     */
    shipitFix?: {
      sourceRef: string;
      sourceExact: boolean;
      refSource?: "build-id" | "checkout-head";
      targetRepo?: string;
      diagnosis?: string;
    };
  };
  /**
   * docs/196 — when set, this message renders a `ChildMergedCard` inline in the
   * PARENT's chat: a child session the parent armed a notify-on-merge watch on
   * had its PR merge (or close without merging). Populated from `child_merged_card`
   * WS events and from persisted history (static payload, no client store).
   */
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
    createdAt: string;
  };
  /**
   * docs/171 — when set, this message renders an inline `ReleaseLifecycleCard`.
   * Carries the full `ReleaseStatusSummary` snapshot; the `release_card` WS
   * handler upserts it by `cardId`, so every phase transition (propose → tagged
   * → released/failed, cancelled) patches the same card in place. Persisted to
   * chat history so it survives reload + restart (no client store).
   */
  releaseCard?: ReleaseStatusSummary;
  /**
   * docs/117 cross-cutting follow-up — when set, this message renders a
   * `SpawnFailedCard` inline in the parent's chat. Populated from
   * `session_spawn_failed` WS events. Counterpart to `spawnedSession` for the
   * failure path so a quota / archived-parent rejection is visible alongside
   * successful spawns instead of only on the shim's stderr.
   */
  spawnFailed?: {
    /** Server-generated stable id, used for live-append idempotency on reconnect. */
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
    /** docs/162 — true when the rejected spawn was an Ops ShipIt fix session. */
    shipitSource?: boolean;
    failedAt: string;
  };
  /**
   * docs/203 — when set, this message renders a plain-text `ReviewCard` inline
   * in the chat. **Legacy read path only (docs/220):** new AI reviews no longer
   * produce this card (cross-agent → consult card, same-model → prose), so this
   * is populated solely by rehydrating the persisted `aiReview` column for rows
   * written before docs/220. Pre-docs/203 rows arrive degraded (`legacy: true`).
   */
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
    needsAttention: boolean;
    kind: "authored" | "ask" | "plan";
    createdAt: string;
  };
  /**
   * User-side counterpart to `aiReview`: when the user submits comments on
   * a doc or diff, the optimistic user bubble carries this payload so the
   * chat renders a dedicated `UserReviewCard` (header + comment count +
   * collapsed prompt disclosure) instead of dumping the raw prompt as a
   * plain text bubble. Without this, the "Send comments" button looked like
   * it did nothing — the agent silently kicked off with no preceding user
   * card and no spinner.
   */
  userReview?: {
    /** Files the comments are anchored to (empty for multi-file diffs). */
    filePaths: string[];
    /** Number of comments included in the submission. */
    commentCount: number;
  };
  /**
   * docs/164 — when set, this message renders a `BugReportCard` inline in the
   * chat. The live `bug_report_card` WS handler appends a `{ cardId }`-only
   * marker; a message rehydrated from persisted chat history additionally
   * carries the full payload + lifecycle so `loadSessionHistory` can seed the
   * bug-report store (the card's editable payload + phase live in that store so
   * a filed/failed update can swap the card in place). `BugReportCard` itself
   * only reads `cardId` and pulls the rest from the store.
   */
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
  /**
   * docs/193 / SHI-112 — when set, this message renders a `PermissionRequestCard`
   * inline (approve/deny + remember) for a gated agent action. The live
   * `permission_request_card` WS handler appends a `{ requestId }`-only marker;
   * a message rehydrated from persisted history additionally carries the full
   * payload + phase so `loadSessionHistory` can seed the permission store (the
   * card's state lives there so an approved/denied/expired update can swap it in
   * place). `PermissionRequestCard` reads only `requestId` and pulls the rest
   * from the store.
   */
  permissionPrompt?: {
    requestId: string;
    phase?: "pending" | "approved" | "denied";
    toolName?: string;
    path?: string;
    summary?: string;
    agentId?: string;
    createdAt?: string;
    remembered?: boolean;
  };
  /**
   * docs/172 / SHI-90 — when set, this message renders an `EgressPromptCard`
   * inline (allow once / add to allowlist / deny) for a host the Tier C SNI
   * proxy blocked. The live `egress_prompt_card` WS handler appends a
   * `{ cardId }`-only marker; a message rehydrated from persisted history also
   * carries host + phase so `loadSessionHistory` can seed the egress-prompt
   * store. `EgressPromptCard` reads only `cardId` and pulls the rest from the store.
   */
  egressPrompt?: {
    cardId: string;
    host?: string;
    phase?: "pending" | "allowed-once" | "added" | "denied";
    createdAt?: string;
  };
  /**
   * docs/177 — when set, this message renders an `IssueWriteCard` inline. The
   * live `issue_write_card` WS handler appends a `{ cardId }`-only marker; a
   * message rehydrated from persisted history additionally carries the full
   * `IssueWriteCard` so `loadSessionHistory` can seed the issue-write store
   * (the card's payload + undo lifecycle live there). `IssueWriteCard` reads
   * only `cardId` and pulls the rest from the store.
   */
  issueWrite?: {
    cardId: string;
  } & Partial<IssueWriteCardData>;
  /**
   * docs/188 — when set, this message renders a read-only `IssueRefCard` inline
   * (the agent ran `shipit issue view`). The card has no lifecycle, so both the
   * live `issue_ref_card` WS handler and a history rehydration carry the full
   * payload on the message; the component renders straight from it (no store).
   */
  issueRef?: IssueRefCardData;
  /**
   * docs/178 — when set, this message renders a `CompactionCard` inline ("Context
   * compacted"). Populated from `compaction_card` WS events and rehydrated from
   * persisted history (the card lives on the message itself, like `voiceNote`,
   * so no separate store seeding is needed). All detail fields are optional —
   * Codex supplies none, so the card degrades to a bare summary row.
   */
  compaction?: CompactionCardData;
  /**
   * docs/144 — when set, this message renders the inline "Consulted Codex · 47s"
   * card for a completed sub-agent spawn. Populated from `sub_agent_consult_card`
   * WS events and rehydrated from persisted history (the card lives on the message
   * itself, like `compaction`, so no separate store seeding is needed). This is
   * the terminal record; the in-flight spinner is the transient `subAgentSpawns`
   * store, cleared when this card arrives.
   */
  subAgentConsult?: SubAgentConsultCardData;
  /**
   * docs/207 / SHI-153 — when set, this message renders an `ActionChecklistCard`
   * inline (a button for one proposed action, a checklist for 2+). The card has
   * no lifecycle and no store, so both the live `action_checklist_card` WS
   * handler and a history rehydration carry the full payload on the message; the
   * component renders straight from it. The only post-submit visual change (the
   * transient "Submitted · N sent" ack) is client-only component state, never
   * persisted — so on reload the card returns to its original definition.
   */
  actionChecklist?: ActionChecklistCardData;
  /**
   * docs/218 — when set, this message renders a `BranchUpdatedCard` inline ("Branch
   * updated to latest <base>"), shown right after the user's message when a merged
   * session's branch was auto-reset to `origin/<base>` before the turn ran. The
   * card has no lifecycle and no store, so both the live `branch_auto_reset_card`
   * WS handler and a history rehydration carry the full payload on the message; the
   * component renders straight from it.
   */
  branchAutoReset?: BranchAutoResetCardData;
  /**
   * docs/221 — when set, this message renders an inline "Synced with <base>" card
   * recording a manual "Sync with <base>" that rebased the session branch onto
   * `origin/<base>` and/or fast-forwarded the local `<base>` ref. The card has no
   * lifecycle and no store, so both the live `branch_synced_card` WS handler and a
   * history rehydration carry the full payload on the message; the component
   * renders straight from it.
   */
  branchSynced?: BranchSyncedCardData;
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
