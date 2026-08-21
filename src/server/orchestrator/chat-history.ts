import crypto from "node:crypto";
import type { DatabaseManager } from "../shared/database.js";
import type { SubagentEvent, ToolResultEntry } from "./session-runner.js";
import type { IssueWriteCard, IssueRefCard, CompactionCard, ChildMergedCard, SelfMergeWatchCard, SessionReportCard, SubAgentConsultCard, AiReviewCard, ActionChecklistCard, BranchAutoResetCard, BranchSyncedCard, SessionRenamedCard, SessionSettingsChangeCard, NonTurnFailureCard, SessionMessageOrigin } from "../shared/types.js";
import type { ReleaseStatusSummary } from "../shared/types/release-types.js";
import type { AgentInterfaceProvenance } from "../shared/agent-interface-sdk/protocol.js";
import { retireBackgroundSubagentResult } from "./subagent-completion.js";
import type {
  BackgroundSubagentCompletion,
  RetiredSubagentHit,
  RetiredSubagentResult,
} from "./subagent-completion.js";

export type RewindSnapshotAction = "chat" | "code" | "both" | "fork";

/**
 * docs/164 — the persisted state of an inline bug-report consent card. Mirrors
 * the client `BugReportCardState` (plus `createdAt`) so a card can be rehydrated
 * straight from chat history on a session switch / full reload, and so its
 * lifecycle (filed / failed) survives — the card and its terminal state were
 * previously client-only and vanished on reload. The card is recorded in-band
 * with the turn that proposed it (see `RecordedBugReportCard`) so it lands at
 * its true transcript position; `filed`/`failed` transitions patch this record
 * in place via `updateBugReportCard`.
 */
export interface PersistedBugReport {
  cardId: string;
  /**
   * `dismissed` (nikzlabs/shipit#2350) is the persisted form of the user clicking
   * Cancel. It was previously local component state, so a reload resurrected a
   * declined card as an editable draft.
   */
  phase: "draft" | "filing" | "filed" | "failed" | "dismissed";
  title: string;
  body: string;
  /** False → the deep semantic redaction pass didn't run; the card warns. */
  stage2Ran: boolean;
  producer: "session" | "ops";
  /** GitHub login the issue is filed as. */
  filedAs?: string;
  createdAt?: string;
  /** Set in the `filed` phase. */
  issueNumber?: number;
  issueUrl?: string;
  /** Set when a failed attempt dropped the card back to an editable draft. */
  errorMessage?: string;
  scopeError?: boolean;
  /**
   * nikzlabs/shipit#2350 — true once the outcome has been prefixed onto a user turn,
   * so the agent is told exactly once. Lives on the card rather than in the
   * session's single `pendingAgentNotice` slot because that slot is
   * last-write-wins by design (its writers all describe the same thing, where
   * the branch points); a bug outcome and a branch notice would clobber each
   * other, and two reports resolved between turns must both be reported.
   */
  agentNotified?: boolean;
}

/**
 * A bug-report card the user has actually resolved. Narrowing `phase` at the
 * boundary is what lets `buildBugOutcomeNotice` take a two-value union instead
 * of a bare string — otherwise a `draft` card reaching it would silently render
 * as "DECLINED".
 */
export type ResolvedBugReport = PersistedBugReport & { phase: "filed" | "dismissed" };

/**
 * docs/172 / planning#92 — the persisted state of an inline egress allow-once card.
 * The Tier C SNI proxy denies a non-allowlisted host and the orchestrator's
 * decision endpoint emits this card off the agent-event stream, so it's recorded
 * in-band with the active turn and persisted here; the allow-once / add /
 * denied transition patches the record in place via `updateEgressPromptCard` so
 * a resolved card stays resolved on reload. Keyed by `cardId` (stable per
 * session+host, so a re-denied host doesn't double-card).
 */
export interface PersistedEgressPrompt {
  cardId: string;
  host: string;
  phase: "pending" | "allowed-once" | "added" | "denied";
  createdAt: string;
}

/**
 * docs/193 / planning#114 — the persisted state of an inline permission-request card
 * (agent-agnostic: Claude's sensitive-file gate, Codex's escalation approval).
 * Recorded in-band with the turn that raised it (off the agent-event stream via
 * the broker's `agent_permission_request` broadcast), so it lands at its true
 * transcript position and its terminal state (approved / denied) survives a
 * reload. Lifecycle transitions patch this record in place via
 * `updatePermissionCard`. `requestId` is the broker's id — the SAME key the WS
 * card, the client store, and the `resolve_permission` round-trip use, so a
 * rehydrated card lines up with its live counterpart (don't rename it to
 * `cardId`: the client keys on `requestId`).
 */
export interface PersistedPermissionRequest {
  requestId: string;
  phase: "pending" | "approved" | "denied";
  toolName: string;
  path?: string;
  summary?: string;
  /** The gated call in full (raw command / pretty-printed input) for the card's disclosure. */
  details?: string;
  agentId?: string;
  createdAt: string;
  /** True when the user approved with "remember this file for the session". */
  remembered?: boolean;
}

export type RewindSnapshotPayload =
  | { action: "chat"; messages: PersistedMessage[] }
  | { action: "code"; headHash: string; flippedMessageIds: number[] }
  | { action: "both"; messages: PersistedMessage[]; headHash: string }
  | { action: "fork"; childSessionId: string; breadcrumbMessageId: number };

export interface RewindSnapshotInfo {
  id: string;
  sessionId: string;
  action: RewindSnapshotAction;
  expiresAt: number;
}

interface RewindSnapshotRow {
  id: string;
  session_id: string;
  action: RewindSnapshotAction;
  payload_json: string;
  created_at_ms: number;
  expires_at_ms: number;
}

/**
 * A single persisted chat message.
 *
 * This mirrors the client-side `ChatMessage` shape so the client can
 * use the data directly without transformation.
 */
export interface PersistedMessage {
  role: "user" | "assistant";
  text: string;
  agentInterface?: AgentInterfaceProvenance;
  /** Another session's agent supplied this prompt, rather than the user. */
  messageOrigin?: SessionMessageOrigin;
  toolUse?: {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
  }[];
  images?: {
    /**
     * Base64 payload. Always present in storage; replaced by `src` on the
     * serve path (docs/244) so a transcript load doesn't carry megabytes of
     * base64 for a 96px thumbnail.
     */
    data?: string;
    mediaType: string;
    /** docs/244 — content-addressed URL, set only on the serve path. */
    src?: string;
  }[];
  files?: {
    path: string;
    contentPreview: string;
    startLine?: number;
    endLine?: number;
  }[];
  isError?: boolean;
  /**
   * Round-trips verbatim via the `tool_results` JSON column, so no schema
   * migration is needed when a field is added. Shares `ToolResultEntry` with the
   * live path rather than restating its shape: the two had already drifted once
   * (docs/244's `truncated`/`totalLines` reached the runner type but not this
   * one), and a structural copy makes that failure silent.
   */
  toolResults?: ToolResultEntry[];
  /** True while the agent turn that produced this message is still running. */
  inProgress?: boolean;
  /** Git commit hash produced by auto-commit after this assistant message. */
  commitHash?: string;
  /** Parent commit hash (HEAD before the auto-commit). Used for rollback. */
  parentCommitHash?: string;
  /** Upload paths consumed by this message (for hydration of pending vs sent state). */
  uploadPaths?: string[];
  notice?: boolean;
  noticeLevel?: "info" | "warn";
  rolledBack?: boolean;
  forkChild?: { childSessionId: string; title: string; branch: string };
  codeRollbackHash?: string;
  /**
   * docs/163 — when set, this message renders an inline `VoiceNoteCard`. Voice
   * notes arrive on a side channel (not the agent-event stream), so they aren't
   * captured by `buildTurnMessages`; they are persisted directly so the card
   * survives a history reload like any other transcript content.
   *
   * Rows written before the `needsAttention` gate was removed carry an extra
   * `needsAttention` key in the stored JSON. It is deliberately absent from this
   * type and read by nothing — legacy rows rehydrate and render as ordinary
   * notes, so no migration is needed.
   */
  voiceNote?: {
    id: string;
    headline: string;
    kind: "authored" | "ask" | "plan";
    createdAt: string;
  };
  /**
   * docs/164 — when set, this message renders an inline `BugReportCard`. Like
   * voice notes, the consent card arrives off the agent-event stream (the
   * `report_shipit_bug` HTTP relay) so `buildTurnMessages` doesn't capture it on
   * its own; it is recorded in-band with the proposing turn and persisted here
   * so the card — and its filed/failed terminal state — survives a history
   * reload like any other transcript content.
   */
  bugReport?: PersistedBugReport;
  /**
   * docs/193 / planning#114 — when set, this message renders an inline
   * `PermissionRequestCard` (approve/deny + remember). Like the bug-report card
   * it arrives off the agent-event stream (the broker's `agent_permission_request`
   * broadcast) so it's recorded in-band with the proposing turn and persisted
   * here; the approved/denied transition patches this record in place via
   * `updatePermissionCard` so a resolved card stays resolved on reload.
   */
  permissionPrompt?: PersistedPermissionRequest;
  /**
   * docs/172 / planning#92 — when set, this message renders an inline
   * `EgressPromptCard` (allow once / add to allowlist / deny). The Tier C SNI
   * proxy denies a non-allowlisted host and the orchestrator decision endpoint
   * emits it off the agent-event stream, so it's recorded in-band with the turn
   * via `emitChatCard` and persisted here; the resolution patches this record in
   * place via `updateEgressPromptCard` so it stays resolved on reload.
   */
  egressPrompt?: PersistedEgressPrompt;
  /**
   * docs/177 — when set, this message renders an inline issue-write provenance
   * card ("agent commented on …", "set planning#30 → In Review") with an Undo
   * affordance. Like the bug-report card it arrives off the agent-event stream
   * (the `shipit issue` write relay) so it's recorded in-band with the
   * proposing turn and persisted here; the undo transition patches this record
   * in place via `updateIssueWriteCard` so an undone card stays undone on
   * reload.
   */
  issueWrite?: IssueWriteCard;
  /**
   * docs/188 — when set, this message renders an inline issue **read**
   * navigation card ("agent viewed planning#30") with a jump-to-issue link. Arrives
   * off the agent-event stream (the `shipit issue view` read relay) so
   * `buildTurnMessages` doesn't capture it; recorded in-band with the turn via
   * `emitChatCard` and persisted here so it survives a reload. Unlike the write
   * card it has no lifecycle, so the full payload lives on this record (no
   * client store) and never needs an in-place patch.
   */
  issueRef?: IssueRefCard;
  /**
   * docs/178 — when set, this message renders an inline "Context compacted" card.
   * Compaction signals arrive off the agent-event stream
   * (`system/compact_boundary`, Codex `contextCompaction` items), so
   * `buildTurnMessages` doesn't capture them on its own; the card is recorded
   * in-band with the turn (via `emitChatCard`) and persisted here so it survives
   * a history reload like any other transcript content.
   */
  compaction?: CompactionCard;
  /**
   * docs/144 — when set, this message renders an inline "Consulted Codex · 47s"
   * card for a completed sub-agent spawn. The spawn fires `shipit agent run`
   * mid-turn (an HTTP relay, off the agent-event stream), so `buildTurnMessages`
   * doesn't capture it on its own; the card is recorded in-band via `emitChatCard`
   * and persisted here so the terminal record survives a session switch / full
   * reload instead of vanishing like the transient in-flight spinner does.
   * Static payload (no client store) — rendered straight from this field.
   */
  subAgentConsult?: SubAgentConsultCard;
  /**
   * docs/252 phase 7 (req 9) — when set, this message renders the inline,
   * dismissible notice that non-turn work failed (session naming, a
   * pull-request description). Persisted rather than emitted-only because
   * naming is fire-and-forget: it routinely finishes with the user on another
   * session or no viewer attached at all, which is exactly the case a transient
   * message cannot reach. Dismissal patches `dismissedAt` on this payload — the
   * row stays, so "I read it" and "it never happened" stay distinguishable.
   */
  nonTurnFailure?: NonTurnFailureCard;
  /**
   * docs/207 / planning#155 — when set, this message renders an inline
   * `ActionChecklistCard` (a button for one proposed action, a checklist for
   * 2+). The `propose_actions` tool fires an HTTP relay off the agent-event
   * stream, so `buildTurnMessages` doesn't capture it; the card is recorded
   * in-band with the proposing turn via `emitChatCard` and persisted here so it
   * survives a reconnect / switch / reload. The card is an IMMUTABLE, reusable
   * message composer — no lifecycle, no terminal state — so the record is
   * written once on emit and never patched (the only post-submit visual change,
   * the transient "Submitted · N sent" ack, is client-only and never persisted).
   */
  actionChecklist?: ActionChecklistCard;
  /**
   * docs/218 — when set, this message renders an inline "Branch updated to latest
   * base" card. Emitted right after the user's message when a merged session's
   * branch was auto-reset to `origin/<base>` before the turn ran (a side-channel
   * card, off the agent-event stream), recorded in-band via `emitChatCard` and
   * persisted here so the destructive move's record survives a switch/reload.
   * Immutable static payload — written once on emit, never patched.
   */
  branchAutoReset?: BranchAutoResetCard;
  /**
   * docs/221 — when set, this message renders an inline "Synced with <base>"
   * card recording a manual "Sync with <base>" that rebased the session branch
   * onto `origin/<base>` and/or fast-forwarded the local `<base>` ref. A
   * side-channel card off the agent-event stream (the clean-rebase path isn't an
   * agent turn), appended directly to history so the sync's record survives a
   * switch/reload. Immutable static payload — written once on emit, never patched.
   */
  branchSynced?: BranchSyncedCard;
  /**
   * docs/250 — when set, this message renders an inline "renamed this session"
   * card recording that the agent retitled the session with
   * `shipit session rename` (requirement 9). A side-channel card off the
   * agent-event stream (it relays over HTTP mid-turn), recorded in-band via
   * `emitChatCard` and persisted here so the record survives a switch/reload.
   * Immutable static payload — written once on emit, never patched.
   */
  sessionRenamed?: SessionRenamedCard;
  /**
   * docs/279 — when set, this message renders an inline "session settings
   * changed" card: a sandbox capability grant edited after creation, or a
   * regular session's network containment mode changed (requirements 7 + 8).
   * A side-channel card off the agent-event stream (it originates in an HTTP
   * route and routinely lands post-turn), emitted through `emitChatCard` and
   * persisted here so the trust boundary moving is still in the scrollback
   * tomorrow. Immutable static payload — written once on emit, never patched.
   */
  sessionSettingsChange?: SessionSettingsChangeCard;
  /**
   * docs/196 — when set, this message renders an inline "Child PR merged /
   * closed" card in the PARENT session's transcript. Surfaced from a PR-poller
   * event (a watched child's PR reached a terminal state) — outside any turn, so
   * it's appended directly to history and persisted here so it survives a reload
   * like any other transcript content. Static payload (no client store).
   */
  childMerged?: ChildMergedCard;
  /**
   * docs/239 — when set, this message renders the inline "will continue when PR
   * #N merges" card the agent's `shipit session notify-on-merge --self` armed.
   * A side-channel card (the arm relays over HTTP mid-turn, off the agent-event
   * stream), recorded in-band via `emitChatCard` and persisted here so it
   * survives a switch/reload. Immutable static payload — written once on emit,
   * never patched; terminal outcomes append a plain note instead.
   */
  selfMergeWatch?: SelfMergeWatchCard;
  /**
   * docs/233 (planning#243) — when set, this message renders an inline "session
   * report" card: another session in this session's cohort (a child, or a
   * sibling on a cohort broadcast) pushed a report here via `shipit session
   * report`. Arrives over HTTP outside any of THIS session's turns, so it's
   * appended directly to history and persisted here so it survives a
   * switch/reload like any other transcript content. Static payload.
   */
  sessionReport?: SessionReportCard;
  /**
   * docs/171 — when set, this message renders an inline `ReleaseLifecycleCard`.
   * A release is proposed by the agent (a marker in its turn text) and reflected
   * by the `ReleaseStatusPoller`, which drives every phase transition through
   * one sink that persists here (upsert by `cardId`) and emits a `release_card`
   * WS. Carrying the full snapshot makes the card a normal persisted transcript
   * card: it survives a reconnect, switch, reload, AND an orchestrator restart,
   * and collapses to its terminal state (`released`/`failed`/`cancelled`) in
   * place. Patched via `upsertReleaseCard`, keyed by `cardId`.
   */
  releaseCard?: ReleaseStatusSummary;
  /**
   * docs/117 Phase 2 — when set, this message renders an inline
   * `SpawnedSessionCard` for a child the agent spawned via `shipit session
   * create`. Emitted off the agent-event stream (the session-create HTTP
   * relay), recorded in-band with the spawning turn and persisted here so the
   * card survives a reload/switch. (Previously emit-only — it relied on the
   * sidebar `session_list` as a reload fallback, which left the parent's
   * transcript non-deterministic across reload.) The card's live status pill
   * still derives from the session store; only the static payload persists.
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
  /**
   * docs/117 cross-cutting follow-up — when set, renders an inline
   * `SpawnFailedCard` for a rejected `shipit session create`. Unlike a
   * successful spawn there is no sidebar row to fall back on, so persisting
   * this is the only way the failure survives a reload. `id` is server-
   * generated (no natural key) and used for live-append idempotency.
   */
  spawnFailed?: {
    id: string;
    title?: string;
    reason: "quota_per_turn" | "quota_per_parent" | "invalid_request" | "parent_missing" | "error";
    message: string;
    statusCode: number;
    promptPreview?: string;
    shipitSource?: boolean;
    failedAt: string;
  };
  /**
   * docs/203 — when set, renders an inline plain-text `ReviewCard`, keyed by
   * `reviewId`. **Legacy read path only (docs/220):** the `submit_review` write
   * path was removed, so no new rows set this field (cross-agent reviews surface
   * in the consult card, same-model reviews are narrated as prose). Retained so
   * rows persisted before docs/220 — and degraded pre-docs/203 `agent_review`
   * rows mapped to a `legacy: true` `AiReviewCard` — still render on read.
   */
  aiReview?: AiReviewCard;
  /**
   * User-side counterpart to `agentReview`: set on the initiating user message
   * when the user submits doc/diff comments via "Send comments", so the bubble
   * renders a `UserReviewCard` instead of a raw prompt. The prompt text lives on
   * `text` (source of truth); this metadata persists so the card chrome survives
   * a reload rather than degrading to a plain text bubble.
   */
  userReview?: {
    filePaths: string[];
    commentCount: number;
  };
  /**
   * docs/138 — stable id for a persisted `system_notice` bubble. Notices are
   * recorded in-band (mid-turn) or appended (post-turn); the id lets the live
   * client handler dedupe a notice re-delivered by the turn-event buffer replay
   * on reconnect against the copy already loaded from history.
   */
  noticeId?: string;
  /**
   * Events emitted by subagents (Claude's Task tool) whose parent Task tool is
   * in this message's `toolUse`. Stored as a flat ordered list keyed by
   * `parentToolUseId` so the client can render the subagent's prompt, work,
   * and final report under the parent Task call (109 — subagent transparency).
   */
  subagentEvents?: SubagentEvent[];
}

interface MessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string;
  tool_use: string | null;
  images: string | null;
  files: string | null;
  is_error: number;
  commit_hash: string | null;
  parent_commit_hash: string | null;
  in_progress: number;
  tool_results: string | null;
  upload_paths: string | null;
  rolled_back: number;
  notice: number;
  notice_level: string | null;
  fork_child: string | null;
  code_rollback_hash: string | null;
  voice_note: string | null;
  bug_report: string | null;
  permission_prompt: string | null;
  egress_prompt: string | null;
  issue_write: string | null;
  issue_ref: string | null;
  compaction: string | null;
  sub_agent_consult: string | null;
  non_turn_failure: string | null;
  action_checklist: string | null;
  branch_auto_reset: string | null;
  branch_synced: string | null;
  session_renamed: string | null;
  session_settings_change: string | null;
  child_merged: string | null;
  self_merge_watch: string | null;
  session_report: string | null;
  release_card: string | null;
  spawned_session: string | null;
  spawn_failed: string | null;
  /** Legacy pre-docs/203 structured agent-review breadcrumb. Read-only — mapped
   * to a degraded `aiReview` in `fromRow`; never written after docs/203. */
  agent_review: string | null;
  /** docs/203 — plain-text AI review card (`AiReviewCard` JSON). */
  ai_review: string | null;
  user_review: string | null;
  notice_id: string | null;
  agent_interface: string | null;
  message_origin: string | null;
  /**
   * Legacy column — older rows may carry a serialized per-turn usage record
   * here. The canonical per-turn series is now owned by `UsageManager`
   * (`usage_turns` table); we no longer write to this column. Kept on the
   * row interface so that `SELECT *` decoding still type-checks against the
   * existing schema.
   */
  turn_usage: string | null;
  subagent_events: string | null;
  created_at: string;
}

const INSERT_SQL = `
  INSERT INTO messages (session_id, role, content, tool_use, images, files, is_error, commit_hash, parent_commit_hash, in_progress, tool_results, upload_paths, turn_usage, subagent_events, rolled_back, notice, notice_level, fork_child, code_rollback_hash, voice_note, bug_report, permission_prompt, egress_prompt, issue_write, issue_ref, compaction, sub_agent_consult, non_turn_failure, action_checklist, branch_auto_reset, branch_synced, session_renamed, session_settings_change, child_merged, self_merge_watch, session_report, release_card, spawned_session, spawn_failed, agent_review, ai_review, user_review, notice_id, agent_interface, message_origin)
  VALUES (@session_id, @role, @content, @tool_use, @images, @files, @is_error, @commit_hash, @parent_commit_hash, @in_progress, @tool_results, @upload_paths, @turn_usage, @subagent_events, @rolled_back, @notice, @notice_level, @fork_child, @code_rollback_hash, @voice_note, @bug_report, @permission_prompt, @egress_prompt, @issue_write, @issue_ref, @compaction, @sub_agent_consult, @non_turn_failure, @action_checklist, @branch_auto_reset, @branch_synced, @session_renamed, @session_settings_change, @child_merged, @self_merge_watch, @session_report, @release_card, @spawned_session, @spawn_failed, @agent_review, @ai_review, @user_review, @notice_id, @agent_interface, @message_origin)
`;

const UPDATE_SQL = `
  UPDATE messages SET role=@role, content=@content, tool_use=@tool_use, images=@images,
    files=@files, is_error=@is_error, commit_hash=@commit_hash, parent_commit_hash=@parent_commit_hash,
    in_progress=@in_progress, tool_results=@tool_results, upload_paths=@upload_paths,
    turn_usage=@turn_usage, subagent_events=@subagent_events, rolled_back=@rolled_back,
    notice=@notice, notice_level=@notice_level, fork_child=@fork_child, code_rollback_hash=@code_rollback_hash,
    voice_note=@voice_note, bug_report=@bug_report, permission_prompt=@permission_prompt, egress_prompt=@egress_prompt, issue_write=@issue_write, issue_ref=@issue_ref, compaction=@compaction, sub_agent_consult=@sub_agent_consult, non_turn_failure=@non_turn_failure, action_checklist=@action_checklist, branch_auto_reset=@branch_auto_reset, branch_synced=@branch_synced, session_renamed=@session_renamed, session_settings_change=@session_settings_change, child_merged=@child_merged, self_merge_watch=@self_merge_watch, session_report=@session_report, release_card=@release_card,
    spawned_session=@spawned_session, spawn_failed=@spawn_failed, agent_review=@agent_review, ai_review=@ai_review, user_review=@user_review, notice_id=@notice_id, agent_interface=@agent_interface, message_origin=@message_origin
  WHERE id = @id
`;

/**
 * Escape the LIKE metacharacters so a literal string matches literally.
 *
 * Load-bearing rather than defensive: a Claude tool_use id is `toolu_…`, and
 * `_` is LIKE's single-character wildcard. Without this the prefilter would
 * quietly match neighbouring ids — harmless today (the structural check behind
 * it rejects them) but a trap for anyone who later trusts the query alone.
 */
function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export class ChatHistoryManager {
  private db;
  private stmtInsert;
  private stmtUpdate;
  private stmtLoadAll;
  private stmtLoadBugReportRows;
  private stmtLoadById;
  private stmtLoadSubAgentCards;
  private stmtLoadByToolUseId;
  private stmtLoadAllPendingSubAgentCards;
  private stmtLoadLast;
  private stmtDeleteBySession;
  private stmtDeleteInProgress;
  private stmtHasInProgress;
  private stmtFinalizeInProgress;
  private stmtFinalizeConsultRows;
  private stmtLoadInProgressConsultRows;
  private stmtLoadFinalizedConsultRows;
  private stmtFinalizeRowById;
  private stmtDeleteRowById;
  private stmtDeleteExpiredSnapshots;
  private stmtTranscriptRevision;

  constructor(dbManager: DatabaseManager) {
    this.db = dbManager.db;
    this.stmtInsert = this.db.prepare(INSERT_SQL);
    this.stmtUpdate = this.db.prepare(UPDATE_SQL);
    this.stmtLoadAll = this.db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id");
    // nikzlabs/shipit#2350 — bug-report cards only. `consumeUnreportedBugOutcomes` runs
    // on EVERY user turn, and a session's transcript is unboundedly long, so it
    // must not pay for `stmtLoadAll`'s full-row materialization to discover
    // (almost always) that there is nothing to report. Narrowed to the id + the
    // one column, over the existing `idx_messages_session`; the common case
    // returns zero rows and the caller short-circuits.
    this.stmtLoadBugReportRows = this.db.prepare(
      "SELECT id, bug_report FROM messages WHERE session_id = ? AND bug_report IS NOT NULL ORDER BY id",
    );
    this.stmtLoadById = this.db.prepare("SELECT * FROM messages WHERE id = ?");
    // docs/248 — `listSubAgentConsultCards` on the `--wait` poll path. No
    // `in_progress` filter, deliberately: a consult that completes while its
    // originating turn is still in flight is persisted by `persistTurnInProgress`
    // as in_progress=1 rows (chat-card-persistence.ts `persistCardTransition`),
    // and a wait that skipped those would never observe the pending → terminal
    // transition on that path.
    this.stmtLoadSubAgentCards = this.db.prepare(
      "SELECT sub_agent_consult FROM messages WHERE session_id = ? AND sub_agent_consult IS NOT NULL ORDER BY id",
    );
    // docs/109 reqs 10–11 — narrowed to the (at most one) row that could hold a
    // given tool_use id, rather than the whole transcript. This runs on EVERY
    // background-task completion, including the `Bash(run_in_background)` jobs
    // that will never match, so a full-row scan per completion would be real
    // work repeated for nothing on a long session. The `LIKE` is a prefilter
    // only — it hands back candidates and `retireBackgroundSubagentResult` still
    // does the structural check — so a false positive costs one `fromRow`.
    this.stmtLoadByToolUseId = this.db.prepare(
      "SELECT * FROM messages WHERE session_id = ? AND tool_results IS NOT NULL "
      + "AND tool_use LIKE ? ESCAPE '\\' ORDER BY id",
    );
    // planning#309 — the boot reconcile's cross-session read. No `in_progress`
    // filter, for the same reason as the per-session query above: a consult
    // stranded inside its own turn is `in_progress=1`, and it is precisely the
    // case that needs reconciling.
    this.stmtLoadAllPendingSubAgentCards = this.db.prepare(
      "SELECT session_id, sub_agent_consult FROM messages WHERE sub_agent_consult IS NOT NULL ORDER BY id",
    );
    // Filters in_progress=0 because `updateLastMessage` (the only caller) is
    // invoked from post-turn auto-commit to write `commit_hash` /
    // `parent_commit_hash` onto the just-finalized assistant message. If the
    // next turn has already begun and inserted in_progress=1 rows, we must
    // skip those — otherwise the commit info gets stamped on a transient row
    // that the very next replaceInProgress() deletes, and the user sees
    // "0 files" in the Rewind preview for a turn that actually committed.
    this.stmtLoadLast = this.db.prepare("SELECT * FROM messages WHERE session_id = ? AND in_progress = 0 ORDER BY id DESC LIMIT 1");
    this.stmtDeleteBySession = this.db.prepare("DELETE FROM messages WHERE session_id = ?");
    this.stmtDeleteInProgress = this.db.prepare("DELETE FROM messages WHERE session_id = ? AND in_progress = 1");
    // nikzlabs/shipit#2350 — does this session have a turn whose rows are still open?
    // `persistCardTransition` needs this to tell a genuinely in-flight turn from
    // the window where the NEXT turn has set `running` but has not yet reset the
    // accumulators. See its docstring.
    this.stmtHasInProgress = this.db.prepare(
      "SELECT 1 FROM messages WHERE session_id = ? AND in_progress = 1 LIMIT 1",
    );
    this.stmtFinalizeInProgress = this.db.prepare("UPDATE messages SET in_progress = 0 WHERE session_id = ? AND in_progress = 1");
    // planning#402 — the consult-durability chokepoint. All five back
    // `replaceInProgress` / `clearInProgress`; see `replaceInProgress` for the
    // invariant they enforce (a terminal consult result is not turn scratch).
    // Same `session_id`-indexed predicate as the delete they guard, so the
    // added work is the same class as work already paid per boundary.
    this.stmtFinalizeConsultRows = this.db.prepare(
      "UPDATE messages SET in_progress = 0 WHERE session_id = ? AND in_progress = 1 AND sub_agent_consult IS NOT NULL",
    );
    this.stmtLoadInProgressConsultRows = this.db.prepare(
      "SELECT id, sub_agent_consult FROM messages WHERE session_id = ? AND in_progress = 1 AND sub_agent_consult IS NOT NULL ORDER BY id",
    );
    this.stmtLoadFinalizedConsultRows = this.db.prepare(
      "SELECT id, sub_agent_consult FROM messages WHERE session_id = ? AND in_progress = 0 AND sub_agent_consult IS NOT NULL ORDER BY id",
    );
    this.stmtFinalizeRowById = this.db.prepare("UPDATE messages SET in_progress = 0 WHERE id = ?");
    this.stmtDeleteRowById = this.db.prepare("DELETE FROM messages WHERE id = ?");
    this.stmtDeleteExpiredSnapshots = this.db.prepare("DELETE FROM rewind_snapshots WHERE expires_at_ms <= ?");
    this.stmtTranscriptRevision = this.db.prepare(
      "SELECT revision FROM transcript_revisions WHERE session_id = ?",
    );
  }

  /**
   * planning#324 — how many times this session's persisted transcript has been
   * written. A value that has not moved is a positive statement that no row of
   * this session's history was inserted, patched or deleted since it was read;
   * `GET /history` folds it into the response's ETag so a tab returning to the
   * foreground can be told "unchanged" without the transcript being loaded,
   * projected and hashed first.
   *
   * The counter is maintained by three triggers on `messages` rather than by
   * this class (see the migration in `database.ts` for why), so it holds for
   * every write path — appends, the in-place card patches that leave the row
   * count and the largest id untouched, and full rewrites through
   * `saveMessages` / `replaceInProgress` alike.
   *
   * 0 for a session that has never had a message. That is a real value, not a
   * failure: it changes as soon as anything is written.
   */
  transcriptRevision(sessionId: string): number {
    const row = this.stmtTranscriptRevision.get(sessionId) as { revision: number } | undefined;
    return row?.revision ?? 0;
  }

  private toRow(sessionId: string, msg: PersistedMessage) {
    return {
      session_id: sessionId,
      role: msg.role,
      content: msg.text,
      tool_use: msg.toolUse ? JSON.stringify(msg.toolUse) : null,
      images: msg.images ? JSON.stringify(msg.images) : null,
      files: msg.files ? JSON.stringify(msg.files) : null,
      is_error: msg.isError ? 1 : 0,
      commit_hash: msg.commitHash ?? null,
      parent_commit_hash: msg.parentCommitHash ?? null,
      in_progress: msg.inProgress ? 1 : 0,
      tool_results: msg.toolResults ? JSON.stringify(msg.toolResults) : null,
      upload_paths: msg.uploadPaths ? JSON.stringify(msg.uploadPaths) : null,
      // Legacy `turn_usage` column — never written from the new path; the
      // per-turn series lives in `usage_turns`.
      turn_usage: null,
      subagent_events: msg.subagentEvents ? JSON.stringify(msg.subagentEvents) : null,
      rolled_back: msg.rolledBack ? 1 : 0,
      notice: msg.notice ? 1 : 0,
      notice_level: msg.noticeLevel ?? null,
      fork_child: msg.forkChild ? JSON.stringify(msg.forkChild) : null,
      code_rollback_hash: msg.codeRollbackHash ?? null,
      voice_note: msg.voiceNote ? JSON.stringify(msg.voiceNote) : null,
      bug_report: msg.bugReport ? JSON.stringify(msg.bugReport) : null,
      permission_prompt: msg.permissionPrompt ? JSON.stringify(msg.permissionPrompt) : null,
      egress_prompt: msg.egressPrompt ? JSON.stringify(msg.egressPrompt) : null,
      issue_write: msg.issueWrite ? JSON.stringify(msg.issueWrite) : null,
      issue_ref: msg.issueRef ? JSON.stringify(msg.issueRef) : null,
      compaction: msg.compaction ? JSON.stringify(msg.compaction) : null,
      sub_agent_consult: msg.subAgentConsult ? JSON.stringify(msg.subAgentConsult) : null,
      non_turn_failure: msg.nonTurnFailure ? JSON.stringify(msg.nonTurnFailure) : null,
      action_checklist: msg.actionChecklist ? JSON.stringify(msg.actionChecklist) : null,
      branch_auto_reset: msg.branchAutoReset ? JSON.stringify(msg.branchAutoReset) : null,
      session_renamed: msg.sessionRenamed ? JSON.stringify(msg.sessionRenamed) : null,
      session_settings_change: msg.sessionSettingsChange ? JSON.stringify(msg.sessionSettingsChange) : null,
      branch_synced: msg.branchSynced ? JSON.stringify(msg.branchSynced) : null,
      child_merged: msg.childMerged ? JSON.stringify(msg.childMerged) : null,
      self_merge_watch: msg.selfMergeWatch ? JSON.stringify(msg.selfMergeWatch) : null,
      session_report: msg.sessionReport ? JSON.stringify(msg.sessionReport) : null,
      release_card: msg.releaseCard ? JSON.stringify(msg.releaseCard) : null,
      spawned_session: msg.spawnedSession ? JSON.stringify(msg.spawnedSession) : null,
      spawn_failed: msg.spawnFailed ? JSON.stringify(msg.spawnFailed) : null,
      // Legacy `agent_review` column — never written after docs/203 (the card is
      // `aiReview` now). Kept readable so old transcript rows still render.
      agent_review: null,
      ai_review: msg.aiReview ? JSON.stringify(msg.aiReview) : null,
      user_review: msg.userReview ? JSON.stringify(msg.userReview) : null,
      notice_id: msg.noticeId ?? null,
      agent_interface: msg.agentInterface ? JSON.stringify(msg.agentInterface) : null,
      message_origin: msg.messageOrigin ? JSON.stringify(msg.messageOrigin) : null,
    };
  }

  private fromRow(row: MessageRow): PersistedMessage {
    const msg: PersistedMessage = {
      role: row.role as PersistedMessage["role"],
      text: row.content,
    };
    if (row.tool_use) msg.toolUse = JSON.parse(row.tool_use) as PersistedMessage["toolUse"];
    if (row.images) msg.images = JSON.parse(row.images) as PersistedMessage["images"];
    if (row.files) msg.files = JSON.parse(row.files) as PersistedMessage["files"];
    if (row.is_error) msg.isError = true;
    if (row.tool_results) msg.toolResults = JSON.parse(row.tool_results) as PersistedMessage["toolResults"];
    if (row.in_progress) msg.inProgress = true;
    if (row.commit_hash) msg.commitHash = row.commit_hash;
    if (row.parent_commit_hash) msg.parentCommitHash = row.parent_commit_hash;
    if (row.upload_paths) msg.uploadPaths = JSON.parse(row.upload_paths) as string[];
    // `turn_usage` column intentionally ignored — see `PersistedMessage`.
    if (row.subagent_events) msg.subagentEvents = JSON.parse(row.subagent_events) as PersistedMessage["subagentEvents"];
    if (row.notice) msg.notice = true;
    if (row.notice_level === "info" || row.notice_level === "warn") msg.noticeLevel = row.notice_level;
    if (row.rolled_back) msg.rolledBack = true;
    if (row.fork_child) msg.forkChild = JSON.parse(row.fork_child) as PersistedMessage["forkChild"];
    if (row.code_rollback_hash) msg.codeRollbackHash = row.code_rollback_hash;
    if (row.voice_note) msg.voiceNote = JSON.parse(row.voice_note) as PersistedMessage["voiceNote"];
    if (row.bug_report) msg.bugReport = JSON.parse(row.bug_report) as PersistedBugReport;
    if (row.permission_prompt) msg.permissionPrompt = JSON.parse(row.permission_prompt) as PersistedPermissionRequest;
    if (row.egress_prompt) msg.egressPrompt = JSON.parse(row.egress_prompt) as PersistedEgressPrompt;
    if (row.issue_write) msg.issueWrite = JSON.parse(row.issue_write) as IssueWriteCard;
    if (row.issue_ref) msg.issueRef = JSON.parse(row.issue_ref) as IssueRefCard;
    if (row.compaction) msg.compaction = JSON.parse(row.compaction) as CompactionCard;
    if (row.sub_agent_consult) msg.subAgentConsult = JSON.parse(row.sub_agent_consult) as SubAgentConsultCard;
    if (row.non_turn_failure) msg.nonTurnFailure = JSON.parse(row.non_turn_failure) as NonTurnFailureCard;
    if (row.action_checklist) msg.actionChecklist = JSON.parse(row.action_checklist) as ActionChecklistCard;
    if (row.branch_auto_reset) msg.branchAutoReset = JSON.parse(row.branch_auto_reset) as BranchAutoResetCard;
    if (row.session_renamed) msg.sessionRenamed = JSON.parse(row.session_renamed) as SessionRenamedCard;
    if (row.session_settings_change) msg.sessionSettingsChange = JSON.parse(row.session_settings_change) as SessionSettingsChangeCard;
    if (row.branch_synced) msg.branchSynced = JSON.parse(row.branch_synced) as BranchSyncedCard;
    if (row.child_merged) msg.childMerged = JSON.parse(row.child_merged) as ChildMergedCard;
    if (row.self_merge_watch) msg.selfMergeWatch = JSON.parse(row.self_merge_watch) as SelfMergeWatchCard;
    if (row.session_report) msg.sessionReport = JSON.parse(row.session_report) as SessionReportCard;
    if (row.release_card) msg.releaseCard = JSON.parse(row.release_card) as ReleaseStatusSummary;
    if (row.spawned_session) msg.spawnedSession = JSON.parse(row.spawned_session) as PersistedMessage["spawnedSession"];
    if (row.spawn_failed) msg.spawnFailed = JSON.parse(row.spawn_failed) as PersistedMessage["spawnFailed"];
    if (row.ai_review) {
      msg.aiReview = JSON.parse(row.ai_review) as AiReviewCard;
    } else if (row.agent_review) {
      // docs/203 migration — degrade a legacy structured agent-review breadcrumb
      // to a plain `aiReview` card so old transcripts still render. The anchored
      // snapshot + comments are gone; surface file + finding count + a note.
      const legacy = JSON.parse(row.agent_review) as {
        reviewId: string;
        filePath: string;
        findingCount?: number;
        createdAt: string;
      };
      msg.aiReview = {
        reviewId: legacy.reviewId,
        filePath: legacy.filePath,
        markdown: "",
        reviewerLabel: "Reviewed earlier",
        legacy: true,
        findingCount: legacy.findingCount ?? 0,
        createdAt: legacy.createdAt,
      };
    }
    if (row.user_review) msg.userReview = JSON.parse(row.user_review) as PersistedMessage["userReview"];
    if (row.notice_id) msg.noticeId = row.notice_id;
    if (row.agent_interface) msg.agentInterface = JSON.parse(row.agent_interface) as PersistedMessage["agentInterface"];
    if (row.message_origin) msg.messageOrigin = JSON.parse(row.message_origin) as PersistedMessage["messageOrigin"];
    return msg;
  }

  /** Append a message to a session's history. */
  append(sessionId: string, message: PersistedMessage): number {
    return this.stmtInsert.run(this.toRow(sessionId, message)).lastInsertRowid as number;
  }

  /** Load all messages for a session. Returns [] if none exist. */
  load(sessionId: string): PersistedMessage[] {
    const rows = this.stmtLoadAll.all(sessionId) as MessageRow[];
    return rows.map((r) => this.fromRow(r));
  }

  /**
   * docs/117 Phase 3 — Return the text of the most-recent assistant message
   * for a session, or `undefined` if there is none. Used by
   * `shipit session view` / `shipit session wait` to surface a preview of the
   * child's latest assistant output without loading the full history into
   * memory.
   */
  loadLatestAssistantText(sessionId: string): string | undefined {
    const row = this.db.prepare(
      "SELECT content FROM messages WHERE session_id = ? AND role = 'assistant' AND content != '' ORDER BY id DESC LIMIT 1",
    ).get(sessionId) as { content: string } | undefined;
    return row?.content;
  }

  /**
   * Update the last finalized message in a session's history by merging
   * fields. Returns the row id that was updated, or null if none. The caller
   * uses the id to derive the message index for `commit_linked` — without
   * this, computing the index via `load().length - 1` would point at a stale
   * in_progress row from the next turn instead of the just-finalized one.
   */
  updateLastMessage(sessionId: string, update: Partial<PersistedMessage>): number | null {
    return this.db.transaction(() => {
      const lastRow = this.stmtLoadLast.get(sessionId) as MessageRow | undefined;
      if (!lastRow) return null;

      const last = this.fromRow(lastRow);
      Object.assign(last, update);
      const row = this.toRow(sessionId, last);
      this.stmtUpdate.run({ ...row, id: lastRow.id });
      return lastRow.id;
    })();
  }

  /**
   * docs/164 — patch a persisted bug-report card's lifecycle fields in place,
   * keyed by `cardId`. Used by the `submit_bug_report` WS handler so a `filed`
   * (issue number + url) or `failed` (error / scope flag) transition survives a
   * reload. This is the finalized-row fallback inside `persistCardTransition`:
   * when the user confirms while the proposing turn is still in flight, the
   * handler patches the recorded card instead so the transition isn't clobbered
   * by that turn's finalize. Returns true if a matching card was found.
   */
  updateBugReportCard(
    sessionId: string,
    cardId: string,
    patch: Partial<PersistedBugReport>,
  ): boolean {
    return this.db.transaction(() => {
      const rows = this.stmtLoadAll.all(sessionId) as MessageRow[];
      for (const row of rows) {
        if (!row.bug_report) continue;
        const card = JSON.parse(row.bug_report) as PersistedBugReport;
        if (card.cardId !== cardId) continue;
        const merged: PersistedBugReport = { ...card, ...patch };
        const msg = this.fromRow(row);
        msg.bugReport = merged;
        this.stmtUpdate.run({ ...this.toRow(sessionId, msg), id: row.id });
        return true;
      }
      return false;
    })();
  }

  /**
   * nikzlabs/shipit#2350 — true when this session has an unfinalized turn's rows on
   * disk. `persistCardTransition` uses it as the real test of "a turn owns the
   * in-progress set", which `runner.running` only approximates.
   */
  hasInProgress(sessionId: string): boolean {
    return this.stmtHasInProgress.get(sessionId) !== undefined;
  }

  /**
   * nikzlabs/shipit#2350 — read a persisted bug-report card by `cardId`. The dismiss
   * handler needs the card's own title to describe the outcome to the agent,
   * and the client only names the card. Returns undefined when the card lives
   * only in the proposing turn's still-unflushed `recordedCards` — callers
   * check there first.
   */
  getBugReportCard(sessionId: string, cardId: string): PersistedBugReport | undefined {
    for (const { card } of this.bugReportRows(sessionId)) {
      if (card.cardId === cardId) return card;
    }
    return undefined;
  }

  /**
   * Every persisted bug-report card in a session, with its owning row id. Reads
   * only the two columns it needs — the callers run on hot paths (every user
   * turn) where the answer is almost always "no cards at all".
   */
  private bugReportRows(sessionId: string): { id: number; card: PersistedBugReport }[] {
    const rows = this.stmtLoadBugReportRows.all(sessionId) as { id: number; bug_report: string }[];
    const out: { id: number; card: PersistedBugReport }[] = [];
    for (const r of rows) {
      // One corrupt row must not throw on a hot path — `consumeUnreportedBugOutcomes`
      // runs on every user turn, so an unparseable card would break the whole
      // session's turns rather than just its own card.
      try {
        out.push({ id: r.id, card: JSON.parse(r.bug_report) as PersistedBugReport });
      } catch {
        console.error(`[chat-history] skipping unparseable bug_report on message ${r.id}`);
      }
    }
    return out;
  }

  /**
   * nikzlabs/shipit#2350 — read-and-mark every bug-report outcome the agent has not
   * been told about yet, so the next user turn can carry them as a prefix.
   *
   * Read-and-mark in one transaction, exactly like `consumePendingAgentNotice`.
   * Precisely: the mark happens exactly once, so the outcome is delivered AT
   * MOST once. The mark is committed before the prompt is assembled, so a spawn
   * or env-prep failure in between loses it. That direction is deliberate and
   * matches `consumePendingAgentNotice` — a repeated "your report was filed" is
   * worse than a missed one, and the agent-facing copy makes silence the safe
   * fallback ("pending" is the default, not a certainty).
   *
   * Only terminal phases qualify — a `failed` card is back to `draft`, which
   * means the report really is still pending and there is nothing to report.
   */
  consumeUnreportedBugOutcomes(sessionId: string): ResolvedBugReport[] {
    // Cheap probe first: no cards (the overwhelmingly common case) means no
    // transaction and no full-row read at all.
    const pending = this.bugReportRows(sessionId).filter(
      (r): r is { id: number; card: ResolvedBugReport } =>
        !r.card.agentNotified && (r.card.phase === "filed" || r.card.phase === "dismissed"),
    );
    if (pending.length === 0) return [];

    return this.db.transaction(() => {
      const out: ResolvedBugReport[] = [];
      for (const { id, card } of pending) {
        const marked: ResolvedBugReport = { ...card, agentNotified: true };
        // Re-read the full row only for the handful of cards being marked: the
        // update statement rewrites every column, so it needs the whole message.
        const row = this.stmtLoadById.get(id) as MessageRow | undefined;
        if (!row) continue;
        const msg = this.fromRow(row);
        msg.bugReport = marked;
        this.stmtUpdate.run({ ...this.toRow(sessionId, msg), id });
        out.push(marked);
      }
      return out;
    })();
  }

  /**
   * docs/171 — upsert a release lifecycle card, keyed by `cardId`. The
   * `ReleaseStatusPoller` drives every phase transition through one sink (see
   * `onCard`): the first transition (propose) has no row yet, so this APPENDS a
   * carrier message; every later transition (tagged → gating → released/failed,
   * cancelled) PATCHES that same row in place so the card advances and collapses
   * without duplicating. Append-at-end is the correct transcript position: the
   * proposal lands after the agent's turn (mirrors `emitNoticePostTurn`). Unlike
   * the bug-report/egress patches this can run outside a turn (an async poll
   * transition), which is exactly why a finalized-row patch is safe.
   */
  upsertReleaseCard(sessionId: string, card: ReleaseStatusSummary): void {
    this.db.transaction(() => {
      const rows = this.stmtLoadAll.all(sessionId) as MessageRow[];
      for (const row of rows) {
        if (!row.release_card) continue;
        const existing = JSON.parse(row.release_card) as ReleaseStatusSummary;
        if (existing.cardId !== card.cardId) continue;
        const msg = this.fromRow(row);
        msg.releaseCard = card;
        this.stmtUpdate.run({ ...this.toRow(sessionId, msg), id: row.id });
        return;
      }
      this.append(sessionId, { role: "assistant", text: "", releaseCard: card });
    })();
  }

  /**
   * docs/172 / planning#92 — patch a persisted egress allow-once card's phase in
   * place, keyed by `cardId`. Used by the `egress_decision` WS handler so an
   * allow-once / add / denied resolution survives a reload. This is the
   * finalized-row fallback inside `persistCardTransition` (the handler patches
   * the recorded card instead when the proposing turn is still in flight, so the
   * resolution isn't clobbered by that turn's finalize). Returns true if a
   * matching card was found.
   */
  updateEgressPromptCard(
    sessionId: string,
    cardId: string,
    patch: Partial<PersistedEgressPrompt>,
  ): boolean {
    return this.db.transaction(() => {
      const rows = this.stmtLoadAll.all(sessionId) as MessageRow[];
      for (const row of rows) {
        if (!row.egress_prompt) continue;
        const card = JSON.parse(row.egress_prompt) as PersistedEgressPrompt;
        if (card.cardId !== cardId) continue;
        const merged: PersistedEgressPrompt = { ...card, ...patch };
        const msg = this.fromRow(row);
        msg.egressPrompt = merged;
        this.stmtUpdate.run({ ...this.toRow(sessionId, msg), id: row.id });
        return true;
      }
      return false;
    })();
  }

  /**
   * docs/193 — patch a persisted permission-request card's lifecycle in place,
   * keyed by `requestId` (the broker's id). Driven by the broker's
   * `agent_permission_resolved` broadcast (the user's decision) so the card's
   * terminal state (approved / denied) survives a reload. The proposing-turn row
   * is finalized by resolution time, so a direct update is safe. Returns true if
   * a matching card was found.
   */
  updatePermissionCard(
    sessionId: string,
    requestId: string,
    patch: Partial<PersistedPermissionRequest>,
  ): boolean {
    return this.db.transaction(() => {
      const rows = this.stmtLoadAll.all(sessionId) as MessageRow[];
      for (const row of rows) {
        if (!row.permission_prompt) continue;
        const card = JSON.parse(row.permission_prompt) as PersistedPermissionRequest;
        if (card.requestId !== requestId) continue;
        const merged: PersistedPermissionRequest = { ...card, ...patch };
        const msg = this.fromRow(row);
        msg.permissionPrompt = merged;
        this.stmtUpdate.run({ ...this.toRow(sessionId, msg), id: row.id });
        return true;
      }
      return false;
    })();
  }

  /**
   * docs/109 reqs 10–11 — replace a backgrounded subagent's launch
   * acknowledgement with what it actually reported, keyed by the Task's
   * `tool_use_id`.
   *
   * Unlike the card patches above this rewrites a *tool result* rather than a
   * card column, so it walks `toolResults` — and it does not stop at the last
   * row, because the notification routinely arrives turns after the launch. All
   * the "is this the right result to touch" reasoning lives in
   * {@link retireBackgroundSubagentResult}, which is also what the runner's live
   * accumulator is patched through; this method only supplies the rows and
   * writes the hit back. Returns the rewritten entry, or null if no row held an
   * un-retired acknowledgement for that id (a duplicate notification, a Bash
   * background task, or a session that never launched one).
   */
  retireBackgroundSubagentResult(
    sessionId: string,
    completion: BackgroundSubagentCompletion,
    built: RetiredSubagentResult,
  ): RetiredSubagentHit | null {
    const pattern = `%${likeEscape(JSON.stringify(completion.toolUseId))}%`;
    return this.db.transaction(() => {
      const rows = this.stmtLoadByToolUseId.all(sessionId, pattern) as MessageRow[];
      for (const row of rows) {
        const msg = this.fromRow(row);
        const hit = retireBackgroundSubagentResult(msg, completion, built);
        if (!hit) continue;
        this.stmtUpdate.run({ ...this.toRow(sessionId, msg), id: row.id });
        return hit;
      }
      return null;
    })();
  }

  /**
   * planning#247 — the session's persisted sub-agent consult cards, oldest first.
   * Backs `shipit agent result`: the card is the artifact the UI renders, so
   * re-reading it here is what makes "the caller can always fetch exactly what
   * the user sees" true by construction rather than by convention. The recovery
   * path matters most when the caller's own copy never arrived — a shim killed
   * by a foreground tool timeout leaves the spawn running server-side, and its
   * output lands here and nowhere else.
   */
  listSubAgentConsultCards(sessionId: string): SubAgentConsultCard[] {
    // Narrowed to the consult column of the (few) rows that carry one, rather
    // than loading every message row in the session: docs/248's
    // `shipit agent result --wait` re-reads this every 500ms for the length of
    // a wait, and a full-row scan of a long session's transcript per poll is
    // real work to repeat thousands of times.
    const rows = this.stmtLoadSubAgentCards.all(sessionId) as { sub_agent_consult: string }[];
    const out: SubAgentConsultCard[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.sub_agent_consult) as SubAgentConsultCard);
      } catch {
        // Skip an unreadable card rather than throwing, exactly as the boot
        // sweep's query does. This backs `shipit agent result` and its `--wait`
        // poll: one corrupt row must not make every other run in the session
        // unreadable, and it must not turn a completed consult's delivery into
        // an error (planning#402).
      }
    }
    return out;
  }

  /**
   * planning#309 — every `pending` consult card in the DB, across all sessions, with
   * the session that owns it. Backs the boot reconcile (`consult-card-reconcile.ts`),
   * which is a whole-database question rather than a per-session one: a restart
   * strands consults in whichever sessions happened to be running, and the
   * orchestrator does not know which those were.
   *
   * Whole-column scan rather than a `json_extract` predicate: this runs exactly
   * once per process, over the few rows that carry a consult at all, so the
   * simpler query is the right trade. Rows whose JSON is unreadable are skipped
   * — a corrupt card is not worth failing the boot sweep over.
   */
  listPendingSubAgentConsultCards(): { sessionId: string; card: SubAgentConsultCard }[] {
    const rows = this.stmtLoadAllPendingSubAgentCards.all() as {
      session_id: string;
      sub_agent_consult: string;
    }[];
    const out: { sessionId: string; card: SubAgentConsultCard }[] = [];
    for (const row of rows) {
      try {
        const card = JSON.parse(row.sub_agent_consult) as SubAgentConsultCard;
        if (card.status === "pending") out.push({ sessionId: row.session_id, card });
      } catch {
        // Unreadable card JSON — skip it rather than aborting the sweep.
      }
    }
    return out;
  }

  /**
   * planning#280 — patch a persisted sub-agent consult card in place, keyed by
   * `cardId`. The card is created `pending` at spawn time and patched to its
   * terminal status when the run finishes; because docs/236 tells agents to
   * background long consults, that finish is usually AFTER the originating turn
   * finalized, so this finalized-row patch — not a re-record — is the common
   * path. It is the `patchDb` half of `persistCardTransition`; while the
   * originating turn is still in flight and still holds the card in
   * `recordedCards`, that helper patches the recorded copy instead so the turn's
   * own finalize can't clobber the transition. Returns true if a card matched.
   *
   * `opts.finalize` additionally clears the row's `in_progress` flag, so the
   * reconciled card is already in its resting state rather than riding an
   * adopted turn's in-progress set. Only the planning#309 boot reconcile passes it.
   *
   * It used to be load-bearing for DURABILITY: a consult spawned by a FOREGROUND
   * `shipit agent run` is still inside its originating turn when the orchestrator
   * dies, so its row is `in_progress=1`; docs/240 adopts that turn, and the
   * adopted turn's `replaceInProgress` deleted every such row. planning#402 moved
   * that guarantee into `replaceInProgress` itself, which now finalizes an
   * orphaned consult row instead of deleting it — so a patch WITHOUT `finalize`
   * survives the adoption too. `finalize` is still the right thing for the
   * reconcile to pass; it is no longer the only thing standing between a card
   * and the next turn's delete.
   */
  updateSubAgentConsultCard(
    sessionId: string,
    cardId: string,
    patch: Partial<SubAgentConsultCard>,
    opts?: { finalize?: boolean },
  ): boolean {
    return this.db.transaction(() => {
      const rows = this.stmtLoadAll.all(sessionId) as MessageRow[];
      for (const row of rows) {
        if (!row.sub_agent_consult) continue;
        const card = JSON.parse(row.sub_agent_consult) as SubAgentConsultCard;
        if (card.cardId !== cardId) continue;
        const msg = this.fromRow(row);
        msg.subAgentConsult = { ...card, ...patch };
        if (opts?.finalize) msg.inProgress = false;
        this.stmtUpdate.run({ ...this.toRow(sessionId, msg), id: row.id });
        return true;
      }
      return false;
    })();
  }

  /**
   * docs/252 phase 7 (req 9) — mark a persisted non-turn-failure notice as
   * dismissed. Patches the row rather than deleting it, so the record of the
   * failure outlives the user acknowledging it. Returns false when no row
   * carries that `cardId` (a card from another session, or one already swept).
   */
  updateNonTurnFailureCard(
    sessionId: string,
    cardId: string,
    patch: Partial<NonTurnFailureCard>,
  ): boolean {
    return this.db.transaction(() => {
      const rows = this.stmtLoadAll.all(sessionId) as MessageRow[];
      for (const row of rows) {
        if (!row.non_turn_failure) continue;
        const card = JSON.parse(row.non_turn_failure) as NonTurnFailureCard;
        if (card.cardId !== cardId) continue;
        const msg = this.fromRow(row);
        msg.nonTurnFailure = { ...card, ...patch };
        this.stmtUpdate.run({ ...this.toRow(sessionId, msg), id: row.id });
        return true;
      }
      return false;
    })();
  }

  /**
   * docs/177 — find a persisted issue-write provenance card by `cardId`. The
   * undo WS handler reads it to recover the tracker + undo snapshot (the card
   * is the source of truth, not client-supplied state). Returns null if absent.
   */
  findIssueWriteCard(sessionId: string, cardId: string): IssueWriteCard | null {
    const rows = this.stmtLoadAll.all(sessionId) as MessageRow[];
    for (const row of rows) {
      if (!row.issue_write) continue;
      const card = JSON.parse(row.issue_write) as IssueWriteCard;
      if (card.cardId === cardId) return card;
    }
    return null;
  }

  /**
   * docs/177 — patch a persisted issue-write card's undo lifecycle in place,
   * keyed by `cardId` (mirrors `updateBugReportCard`). This is the finalized-row
   * fallback inside `persistCardTransition`: when the user clicks Undo while the
   * card's proposing turn is still in flight, the handler patches the recorded
   * card instead so the undo isn't clobbered by that turn's finalize. Returns
   * true if a matching card was found.
   */
  updateIssueWriteCard(
    sessionId: string,
    cardId: string,
    patch: Partial<IssueWriteCard>,
  ): boolean {
    return this.db.transaction(() => {
      const rows = this.stmtLoadAll.all(sessionId) as MessageRow[];
      for (const row of rows) {
        if (!row.issue_write) continue;
        const card = JSON.parse(row.issue_write) as IssueWriteCard;
        if (card.cardId !== cardId) continue;
        const merged: IssueWriteCard = { ...card, ...patch };
        const msg = this.fromRow(row);
        msg.issueWrite = merged;
        this.stmtUpdate.run({ ...this.toRow(sessionId, msg), id: row.id });
        return true;
      }
      return false;
    })();
  }

  /** Index of a row id within the session's full ordered history. */
  indexOfMessageId(sessionId: string, id: number): number {
    const ids = this.db.prepare("SELECT id FROM messages WHERE session_id = ? ORDER BY id").all(sessionId) as { id: number }[];
    return ids.findIndex((r) => r.id === id);
  }

  /** Truncate a session's history to the first `count` messages. */
  truncate(sessionId: string, count: number): PersistedMessage[] {
    const rows = this.stmtLoadAll.all(sessionId) as MessageRow[];

    if (rows.length > count) {
      const lastKeepId = rows[count - 1].id;
      this.db.prepare(
        "DELETE FROM messages WHERE session_id = ? AND id > ?",
      ).run(sessionId, lastKeepId);
    }

    return rows.slice(0, count).map((r) => this.fromRow(r));
  }

  /** Save messages for a session (overwriting existing history). */
  saveMessages(sessionId: string, messages: PersistedMessage[]): void {
    this.db.transaction(() => {
      this.stmtDeleteBySession.run(sessionId);
      for (const msg of messages) {
        this.stmtInsert.run(this.toRow(sessionId, msg));
      }
    })();
  }

  markRolledBackFromIndex(sessionId: string, gapPosition: number, codeRollbackHash: string): number[] {
    return this.db.transaction(() => {
      const rows = this.stmtLoadAll.all(sessionId) as MessageRow[];
      const targetRows = rows.slice(gapPosition);
      if (targetRows.length === 0) return [];

      const firstId = targetRows[0].id;
      this.db.prepare(`
        UPDATE messages
           SET rolled_back = 1,
               code_rollback_hash = CASE WHEN id = ? THEN ? ELSE code_rollback_hash END
         WHERE session_id = ? AND id >= ?
      `).run(firstId, codeRollbackHash, sessionId, firstId);
      return targetRows.map((r) => r.id);
    })();
  }

  clearRolledBack(sessionId: string, messageIds: number[]): void {
    if (messageIds.length === 0) return;
    const placeholders = messageIds.map(() => "?").join(",");
    this.db.prepare(`
      UPDATE messages
         SET rolled_back = 0,
             code_rollback_hash = NULL
       WHERE session_id = ? AND id IN (${placeholders})
    `).run(sessionId, ...messageIds);
  }

  deleteMessageById(sessionId: string, messageId: number): boolean {
    const result = this.db.prepare("DELETE FROM messages WHERE session_id = ? AND id = ?").run(sessionId, messageId);
    return result.changes > 0;
  }

  createRewindSnapshot(sessionId: string, payload: RewindSnapshotPayload, now = Date.now()): RewindSnapshotInfo {
    const expiresAt = now + 5 * 60 * 1000;
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO rewind_snapshots (id, session_id, action, payload_json, created_at_ms, expires_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, sessionId, payload.action, JSON.stringify(payload), now, expiresAt);
    return { id, sessionId, action: payload.action, expiresAt };
  }

  latestRewindSnapshot(sessionId: string, now = Date.now()): RewindSnapshotInfo | null {
    this.stmtDeleteExpiredSnapshots.run(now);
    const row = this.db.prepare(`
      SELECT * FROM rewind_snapshots
       WHERE session_id = ? AND expires_at_ms > ?
       ORDER BY created_at_ms DESC
       LIMIT 1
    `).get(sessionId, now) as RewindSnapshotRow | undefined;
    return row ? { id: row.id, sessionId: row.session_id, action: row.action, expiresAt: row.expires_at_ms } : null;
  }

  consumeRewindSnapshot(sessionId: string, snapshotId?: string, now = Date.now()): RewindSnapshotPayload | null {
    this.stmtDeleteExpiredSnapshots.run(now);
    const row = this.db.prepare(`
      SELECT * FROM rewind_snapshots
       WHERE session_id = ? AND expires_at_ms > ? ${snapshotId ? "AND id = ?" : ""}
       ORDER BY created_at_ms DESC
       LIMIT 1
    `).get(...(snapshotId ? [sessionId, now, snapshotId] : [sessionId, now])) as RewindSnapshotRow | undefined;
    if (!row) return null;
    this.db.prepare("DELETE FROM rewind_snapshots WHERE id = ?").run(row.id);
    return JSON.parse(row.payload_json) as RewindSnapshotPayload;
  }

  /**
   * Replace all in-progress messages for a session with the given set.
   * Called at each agent_tool_result boundary with the accumulated message groups.
   *
   * Defense-in-depth against duplicate system notices: only `in_progress=1`
   * rows are deleted here, so a notice that some out-of-band finalize already
   * flipped to `in_progress=0` survives the delete — and the same notice is
   * still in the turn's `recordedCards`, so the rebuilt batch re-inserts it as
   * a SECOND, now-permanent row (the double account-failover-notice incident;
   * the primary fix is the turn-epoch guard on stale teardowns). Every notice
   * carries a stable per-emit `noticeId`, so a batch entry whose id already
   * exists on a finalized row of this session is the same emit and is skipped.
   *
   * ## A sub-agent consult card is never turn scratch (planning#402)
   *
   * A consult card is created `pending` mid-turn, so it lives on an
   * `in_progress=1` row for as long as the run takes — minutes to tens of
   * minutes — and its pending → terminal patch lands on that same row. If the
   * owning turn dies in that window (a preempting auto-fix turn, an adopted
   * turn, a crash), the next turn's delete takes the row with it: `shipit agent
   * result` then reads `pending` forever and the consult's entire output is
   * gone. Observed in production with 16,529 characters of review lost while
   * the completion log said `persisted=true`.
   *
   * So the delete is no longer allowed to touch a consult row. Before it runs,
   * every `in_progress=1` row carrying a consult card that this batch does NOT
   * carry is finalized in place — its turn is gone, so nothing will rebuild it,
   * and `in_progress=0` is what makes it outlive every later rebuild.
   *
   * "…that this batch does NOT carry" is load-bearing, not an optimization.
   * A card the batch still holds belongs to a LIVE turn, which re-inserts it at
   * its `afterGroupIndex` anchor on every rebuild; finalizing that row instead
   * would freeze its id while the surrounding assistant rows are reborn with
   * higher ones, floating the card to the top of its own turn. Preserve only
   * what the rebuild would otherwise destroy.
   *
   * The insert side mirrors the notice guard for the same reason it exists: once
   * a card is on a finalized row, re-inserting it from a still-live
   * `recordedCards` would make a duplicate, and a stale `pending` copy sitting
   * on the earlier row shadows the terminal one on every read that takes the
   * first match. So a batch copy that is at least as current REPLACES the
   * surviving row — deleted, then re-inserted at its anchor, which keeps the
   * position that patching in place would have frozen. A batch copy that is
   * stale (pending against a terminal row) is dropped instead: preserving a
   * result outranks preserving a position.
   */
  replaceInProgress(sessionId: string, messages: PersistedMessage[]): void {
    this.db.transaction(() => {
      const batchCardIds = new Set<string>();
      for (const msg of messages) {
        if (msg.subAgentConsult) batchCardIds.add(msg.subAgentConsult.cardId);
      }
      this.preserveOrphanedConsultRows(sessionId, batchCardIds);

      this.stmtDeleteInProgress.run(sessionId);
      let finalizedNoticeIds: Set<string> | null = null;
      let finalizedConsults: Map<string, { id: number; card: SubAgentConsultCard }> | null = null;
      for (const msg of messages) {
        if (msg.noticeId) {
          // Lazy: the query runs only for batches that carry a notice at all,
          // and after the in-progress delete so it sees exactly the rows that
          // will survive this rebuild.
          finalizedNoticeIds ??= new Set(
            (this.db.prepare(
              "SELECT notice_id FROM messages WHERE session_id = ? AND notice_id IS NOT NULL AND in_progress = 0",
            ).all(sessionId) as { notice_id: string }[]).map((r) => r.notice_id),
          );
          if (finalizedNoticeIds.has(msg.noticeId)) continue;
        }
        if (msg.subAgentConsult) {
          // Same lazy shape, and after the delete for the same reason.
          finalizedConsults ??= this.loadFinalizedConsultRows(sessionId);
          const existing = finalizedConsults.get(msg.subAgentConsult.cardId);
          if (existing) {
            if (existing.card.status !== "pending" && msg.subAgentConsult.status === "pending") {
              // The batch copy is the STALE one — a live turn re-flushing a
              // `recordedCards` snapshot taken before the transition. Keep the
              // surviving row; a rebuild must never walk a result back to
              // `pending`, which is the shape the incident reported for hours.
              continue;
            }
            // The batch copy is at least as current, so drop the surviving row
            // and let the insert below place it at its `afterGroupIndex` anchor.
            // Patching the old row in place would keep the card durable but
            // freeze its id while the assistant rows around it are reborn with
            // higher ones — the same float-to-the-top regression the preserve
            // step above is conditional to avoid, reached by the other branch.
            // Re-inserting is not a durability step backwards: the row rejoins
            // this turn's in-progress set, and the preserve step catches it
            // again the moment a foreign rebuild would otherwise delete it.
            this.stmtDeleteRowById.run(existing.id);
            finalizedConsults.delete(msg.subAgentConsult.cardId);
          }
        }
        this.stmtInsert.run(this.toRow(sessionId, msg));
      }
    })();
  }

  /**
   * Finalize in place every `in_progress=1` row of this session that carries a
   * consult card the incoming rebuild does not — see `replaceInProgress` for
   * why. Runs before the delete, so those rows are already `in_progress=0` when
   * it fires and it simply does not see them.
   *
   * The empty-batch case (every ordinary turn boundary — a batch carrying a
   * consult card at all is rare) is one blanket `UPDATE` with the same
   * `session_id`-indexed predicate as the `DELETE` that follows it, and parses
   * no JSON. Only a batch that does carry a card pays the row scan.
   */
  private preserveOrphanedConsultRows(sessionId: string, batchCardIds: Set<string>): void {
    if (batchCardIds.size === 0) {
      this.stmtFinalizeConsultRows.run(sessionId);
      return;
    }
    const rows = this.stmtLoadInProgressConsultRows.all(sessionId) as {
      id: number;
      sub_agent_consult: string;
    }[];
    for (const row of rows) {
      let cardId: string | null = null;
      try {
        cardId = (JSON.parse(row.sub_agent_consult) as SubAgentConsultCard).cardId;
      } catch {
        // Unreadable card JSON — preserve the row rather than deleting it. A
        // corrupt card is still evidence a consult happened.
      }
      if (cardId !== null && batchCardIds.has(cardId)) continue;
      this.stmtFinalizeRowById.run(row.id);
    }
  }

  /** Finalized consult rows of a session, by `cardId`. See `replaceInProgress`. */
  private loadFinalizedConsultRows(sessionId: string): Map<string, { id: number; card: SubAgentConsultCard }> {
    const rows = this.stmtLoadFinalizedConsultRows.all(sessionId) as {
      id: number;
      sub_agent_consult: string;
    }[];
    const out = new Map<string, { id: number; card: SubAgentConsultCard }>();
    for (const row of rows) {
      try {
        const card = JSON.parse(row.sub_agent_consult) as SubAgentConsultCard;
        out.set(card.cardId, { id: row.id, card });
      } catch {
        // Unreadable card JSON — it can't collide with anything by `cardId`.
      }
    }
    return out;
  }

  /** Remove the inProgress flag from all messages. Called on agent_result. */
  finalizeInProgress(sessionId: string): void {
    this.stmtFinalizeInProgress.run(sessionId);
  }

  /**
   * Remove all in-progress messages. Called on agent error/abort.
   *
   * Consult rows are finalized rather than deleted, for the reason spelled out
   * in `replaceInProgress`: a turn that aborts while a consult is in flight
   * still has that consult running server-side, and deleting the row leaves its
   * terminal patch nowhere to land. There is no rebuild here to preserve the
   * card's anchor against, so every consult row is kept.
   */
  clearInProgress(sessionId: string): void {
    this.db.transaction(() => {
      this.stmtFinalizeConsultRows.run(sessionId);
      this.stmtDeleteInProgress.run(sessionId);
    })();
  }

  /** Delete a session's chat history. */
  delete(sessionId: string): boolean {
    const result = this.stmtDeleteBySession.run(sessionId);
    return result.changes > 0;
  }

  /** List session IDs that have stored history. */
  listSessions(): string[] {
    const rows = this.db.prepare(
      "SELECT DISTINCT session_id FROM messages",
    ).all() as { session_id: string }[];
    return rows.map((r) => r.session_id);
  }
}
