import crypto from "node:crypto";
import type { DatabaseManager } from "../shared/database.js";
import type { SubagentEvent, ToolResultEntry } from "./session-runner.js";
import type { IssueWriteCard, IssueRefCard, CompactionCard, ChildMergedCard, SelfMergeWatchCard, SessionReportCard, SubAgentConsultCard, AiReviewCard, ActionChecklistCard, PresentInlineCard, BranchAutoResetCard, BranchSyncedCard, SessionRenamedCard, SessionSettingsChangeCard, NonTurnFailureCard, SessionMessageOrigin } from "../shared/types.js";
import type { ReleaseStatusSummary } from "../shared/types/release-types.js";
import type { AgentInterfaceProvenance } from "../shared/agent-interface-sdk/protocol.js";
import { retireBackgroundSubagentResult } from "./subagent-completion.js";
import type {
  BackgroundSubagentCompletion,
  RetiredSubagentHit,
  RetiredSubagentResult,
} from "./subagent-completion.js";

export type RewindSnapshotAction = "chat" | "code" | "both" | "fork";

export interface PersistedBugReport {
  cardId: string;
  phase: "draft" | "filing" | "filed" | "failed" | "dismissed";
  title: string;
  body: string;
  /** Whether semantic redaction ran. */
  stage2Ran: boolean;
  producer: "session" | "ops";
  /** GitHub login the issue is filed as. */
  filedAs?: string;
  createdAt?: string;
  issueNumber?: number;
  issueUrl?: string;
  errorMessage?: string;
  scopeError?: boolean;
  /** Per-card delivery prevents separate outcomes from replacing each other. */
  agentNotified?: boolean;
}

export type ResolvedBugReport = PersistedBugReport & { phase: "filed" | "dismissed" };

export interface PersistedEgressPrompt {
  cardId: string;
  host: string;
  phase: "pending" | "allowed-once" | "added" | "denied";
  createdAt: string;
}

export interface PersistedPermissionRequest {
  requestId: string;
  phase: "pending" | "approved" | "denied";
  toolName: string;
  path?: string;
  summary?: string;
  details?: string;
  agentId?: string;
  createdAt: string;
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

export interface PersistedMessage {
  role: "user" | "assistant";
  text: string;
  agentInterface?: AgentInterfaceProvenance;
  messageOrigin?: SessionMessageOrigin;
  toolUse?: {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
  }[];
  images?: {
    /** Stored as base64; served as a URL in `src`. */
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
  toolResults?: ToolResultEntry[];
  inProgress?: boolean;
  commitHash?: string;
  parentCommitHash?: string;
  uploadPaths?: string[];
  /** Deduplicates user-message echoes across history loads. */
  clientRequestId?: string;
  notice?: boolean;
  noticeLevel?: "info" | "warn";
  rolledBack?: boolean;
  forkChild?: { childSessionId: string; title: string; branch: string };
  codeRollbackHash?: string;
  voiceNote?: {
    id: string;
    headline: string;
    kind: "authored" | "ask" | "plan";
    createdAt: string;
  };
  bugReport?: PersistedBugReport;
  permissionPrompt?: PersistedPermissionRequest;
  egressPrompt?: PersistedEgressPrompt;
  issueWrite?: IssueWriteCard;
  issueRef?: IssueRefCard;
  compaction?: CompactionCard;
  subAgentConsult?: SubAgentConsultCard;
  nonTurnFailure?: NonTurnFailureCard;
  actionChecklist?: ActionChecklistCard;
  presentInline?: PresentInlineCard;
  branchAutoReset?: BranchAutoResetCard;
  branchSynced?: BranchSyncedCard;
  sessionRenamed?: SessionRenamedCard;
  sessionSettingsChange?: SessionSettingsChangeCard;
  childMerged?: ChildMergedCard;
  selfMergeWatch?: SelfMergeWatchCard;
  sessionReport?: SessionReportCard;
  releaseCard?: ReleaseStatusSummary;
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
  /** Legacy read path; new reviews use consult cards. */
  aiReview?: AiReviewCard;
  userReview?: {
    filePaths: string[];
    commentCount: number;
  };
  noticeId?: string;
  /** Flat event list linked to `toolUse` by `parentToolUseId`. */
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
  client_request_id: string | null;
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
  present_inline: string | null;
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
  agent_review: string | null;
  ai_review: string | null;
  user_review: string | null;
  notice_id: string | null;
  agent_interface: string | null;
  message_origin: string | null;
  /** Legacy column; new usage records live in `usage_turns`. */
  turn_usage: string | null;
  subagent_events: string | null;
  created_at: string;
}

const INSERT_SQL = `
  INSERT INTO messages (session_id, role, content, tool_use, images, files, is_error, commit_hash, parent_commit_hash, in_progress, tool_results, upload_paths, client_request_id, turn_usage, subagent_events, rolled_back, notice, notice_level, fork_child, code_rollback_hash, voice_note, bug_report, permission_prompt, egress_prompt, issue_write, issue_ref, compaction, sub_agent_consult, non_turn_failure, action_checklist, present_inline, branch_auto_reset, branch_synced, session_renamed, session_settings_change, child_merged, self_merge_watch, session_report, release_card, spawned_session, spawn_failed, agent_review, ai_review, user_review, notice_id, agent_interface, message_origin)
  VALUES (@session_id, @role, @content, @tool_use, @images, @files, @is_error, @commit_hash, @parent_commit_hash, @in_progress, @tool_results, @upload_paths, @client_request_id, @turn_usage, @subagent_events, @rolled_back, @notice, @notice_level, @fork_child, @code_rollback_hash, @voice_note, @bug_report, @permission_prompt, @egress_prompt, @issue_write, @issue_ref, @compaction, @sub_agent_consult, @non_turn_failure, @action_checklist, @present_inline, @branch_auto_reset, @branch_synced, @session_renamed, @session_settings_change, @child_merged, @self_merge_watch, @session_report, @release_card, @spawned_session, @spawn_failed, @agent_review, @ai_review, @user_review, @notice_id, @agent_interface, @message_origin)
`;

const UPDATE_SQL = `
  UPDATE messages SET role=@role, content=@content, tool_use=@tool_use, images=@images,
    files=@files, is_error=@is_error, commit_hash=@commit_hash, parent_commit_hash=@parent_commit_hash,
    in_progress=@in_progress, tool_results=@tool_results, upload_paths=@upload_paths,
    client_request_id=@client_request_id,
    turn_usage=@turn_usage, subagent_events=@subagent_events, rolled_back=@rolled_back,
    notice=@notice, notice_level=@notice_level, fork_child=@fork_child, code_rollback_hash=@code_rollback_hash,
    voice_note=@voice_note, bug_report=@bug_report, permission_prompt=@permission_prompt, egress_prompt=@egress_prompt, issue_write=@issue_write, issue_ref=@issue_ref, compaction=@compaction, sub_agent_consult=@sub_agent_consult, non_turn_failure=@non_turn_failure, action_checklist=@action_checklist, present_inline=@present_inline, branch_auto_reset=@branch_auto_reset, branch_synced=@branch_synced, session_renamed=@session_renamed, session_settings_change=@session_settings_change, child_merged=@child_merged, self_merge_watch=@self_merge_watch, session_report=@session_report, release_card=@release_card,
    spawned_session=@spawned_session, spawn_failed=@spawn_failed, agent_review=@agent_review, ai_review=@ai_review, user_review=@user_review, notice_id=@notice_id, agent_interface=@agent_interface, message_origin=@message_origin
  WHERE id = @id
`;

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
    this.stmtLoadBugReportRows = this.db.prepare(
      "SELECT id, bug_report FROM messages WHERE session_id = ? AND bug_report IS NOT NULL ORDER BY id",
    );
    this.stmtLoadById = this.db.prepare("SELECT * FROM messages WHERE id = ?");
    // Include in-progress rows: consults can finish before their owning turn.
    this.stmtLoadSubAgentCards = this.db.prepare(
      "SELECT sub_agent_consult FROM messages WHERE session_id = ? AND sub_agent_consult IS NOT NULL ORDER BY id",
    );
    // LIKE selects candidates; retireBackgroundSubagentResult checks their structure.
    this.stmtLoadByToolUseId = this.db.prepare(
      "SELECT * FROM messages WHERE session_id = ? AND tool_results IS NOT NULL "
      + "AND tool_use LIKE ? ESCAPE '\\' ORDER BY id",
    );
    this.stmtLoadAllPendingSubAgentCards = this.db.prepare(
      "SELECT session_id, sub_agent_consult FROM messages WHERE sub_agent_consult IS NOT NULL ORDER BY id",
    );
    // Post-turn commit metadata must not land on the next turn's transient rows.
    this.stmtLoadLast = this.db.prepare("SELECT * FROM messages WHERE session_id = ? AND in_progress = 0 ORDER BY id DESC LIMIT 1");
    this.stmtDeleteBySession = this.db.prepare("DELETE FROM messages WHERE session_id = ?");
    this.stmtDeleteInProgress = this.db.prepare("DELETE FROM messages WHERE session_id = ? AND in_progress = 1");
    this.stmtHasInProgress = this.db.prepare(
      "SELECT 1 FROM messages WHERE session_id = ? AND in_progress = 1 LIMIT 1",
    );
    this.stmtFinalizeInProgress = this.db.prepare("UPDATE messages SET in_progress = 0 WHERE session_id = ? AND in_progress = 1");
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

  /** SQL triggers advance the revision for every transcript write. */
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
      client_request_id: msg.clientRequestId ?? null,
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
      present_inline: msg.presentInline ? JSON.stringify(msg.presentInline) : null,
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
    if (row.client_request_id) msg.clientRequestId = row.client_request_id;
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
    if (row.present_inline) msg.presentInline = JSON.parse(row.present_inline) as PresentInlineCard;
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

  append(sessionId: string, message: PersistedMessage): number {
    return this.stmtInsert.run(this.toRow(sessionId, message)).lastInsertRowid as number;
  }

  load(sessionId: string): PersistedMessage[] {
    const rows = this.stmtLoadAll.all(sessionId) as MessageRow[];
    return rows.map((r) => this.fromRow(r));
  }

  loadLatestAssistantText(sessionId: string): string | undefined {
    const row = this.db.prepare(
      "SELECT content FROM messages WHERE session_id = ? AND role = 'assistant' AND content != '' ORDER BY id DESC LIMIT 1",
    ).get(sessionId) as { content: string } | undefined;
    return row?.content;
  }

  /** Updates the last finalized row and returns its id. */
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

  hasInProgress(sessionId: string): boolean {
    return this.stmtHasInProgress.get(sessionId) !== undefined;
  }

  getBugReportCard(sessionId: string, cardId: string): PersistedBugReport | undefined {
    for (const { card } of this.bugReportRows(sessionId)) {
      if (card.cardId === cardId) return card;
    }
    return undefined;
  }

  private bugReportRows(sessionId: string): { id: number; card: PersistedBugReport }[] {
    const rows = this.stmtLoadBugReportRows.all(sessionId) as { id: number; bug_report: string }[];
    const out: { id: number; card: PersistedBugReport }[] = [];
    for (const r of rows) {
      try {
        out.push({ id: r.id, card: JSON.parse(r.bug_report) as PersistedBugReport });
      } catch {
        console.error(`[chat-history] skipping unparseable bug_report on message ${r.id}`);
      }
    }
    return out;
  }

  /** Marks outcomes before prompt assembly: delivery is at most once, even if spawning fails. */
  consumeUnreportedBugOutcomes(sessionId: string): ResolvedBugReport[] {
    const pending = this.bugReportRows(sessionId).filter(
      (r): r is { id: number; card: ResolvedBugReport } =>
        !r.card.agentNotified && (r.card.phase === "filed" || r.card.phase === "dismissed"),
    );
    if (pending.length === 0) return [];

    return this.db.transaction(() => {
      const out: ResolvedBugReport[] = [];
      for (const { id, card } of pending) {
        const marked: ResolvedBugReport = { ...card, agentNotified: true };
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

  listSubAgentConsultCards(sessionId: string): SubAgentConsultCard[] {
    const rows = this.stmtLoadSubAgentCards.all(sessionId) as { sub_agent_consult: string }[];
    const out: SubAgentConsultCard[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.sub_agent_consult) as SubAgentConsultCard);
      } catch {
        // One corrupt card must not block other results.
      }
    }
    return out;
  }

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
        // Skip corrupt cards.
      }
    }
    return out;
  }

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

  findIssueWriteCard(sessionId: string, cardId: string): IssueWriteCard | null {
    const rows = this.stmtLoadAll.all(sessionId) as MessageRow[];
    for (const row of rows) {
      if (!row.issue_write) continue;
      const card = JSON.parse(row.issue_write) as IssueWriteCard;
      if (card.cardId === cardId) return card;
    }
    return null;
  }

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

  indexOfMessageId(sessionId: string, id: number): number {
    const ids = this.db.prepare("SELECT id FROM messages WHERE session_id = ? ORDER BY id").all(sessionId) as { id: number }[];
    return ids.findIndex((r) => r.id === id);
  }

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

  /** Preserve consults absent from the rebuild; deduplicate finalized notices and consults. */
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
          finalizedNoticeIds ??= new Set(
            (this.db.prepare(
              "SELECT notice_id FROM messages WHERE session_id = ? AND notice_id IS NOT NULL AND in_progress = 0",
            ).all(sessionId) as { notice_id: string }[]).map((r) => r.notice_id),
          );
          if (finalizedNoticeIds.has(msg.noticeId)) continue;
        }
        if (msg.subAgentConsult) {
          finalizedConsults ??= this.loadFinalizedConsultRows(sessionId);
          const existing = finalizedConsults.get(msg.subAgentConsult.cardId);
          if (existing) {
            if (existing.card.status !== "pending" && msg.subAgentConsult.status === "pending") {
              // A stale snapshot must not replace a completed result.
              continue;
            }
            // Reinsert at the batch position so a fixed row id cannot reorder the card.
            this.stmtDeleteRowById.run(existing.id);
            finalizedConsults.delete(msg.subAgentConsult.cardId);
          }
        }
        this.stmtInsert.run(this.toRow(sessionId, msg));
      }
    })();
  }

  /** Finalize only cards absent from the batch; the rebuild restores the others in order. */
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
        // Preserve corrupt cards as evidence of the consult.
      }
      if (cardId !== null && batchCardIds.has(cardId)) continue;
      this.stmtFinalizeRowById.run(row.id);
    }
  }

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
        // A corrupt card cannot match by cardId.
      }
    }
    return out;
  }

  finalizeInProgress(sessionId: string): void {
    this.stmtFinalizeInProgress.run(sessionId);
  }

  /** Preserve consult rows so their results can arrive after the turn aborts. */
  clearInProgress(sessionId: string): void {
    this.db.transaction(() => {
      this.stmtFinalizeConsultRows.run(sessionId);
      this.stmtDeleteInProgress.run(sessionId);
    })();
  }

  delete(sessionId: string): boolean {
    const result = this.stmtDeleteBySession.run(sessionId);
    return result.changes > 0;
  }

  listSessions(): string[] {
    const rows = this.db.prepare(
      "SELECT DISTINCT session_id FROM messages",
    ).all() as { session_id: string }[];
    return rows.map((r) => r.session_id);
  }
}
