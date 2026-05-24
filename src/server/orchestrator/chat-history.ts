import type { DatabaseManager } from "../shared/database.js";
import type { SubagentEvent } from "./session-runner.js";

/**
 * A single persisted chat message.
 *
 * This mirrors the client-side `ChatMessage` shape so the client can
 * use the data directly without transformation.
 */
export interface PersistedMessage {
  role: "user" | "assistant";
  text: string;
  toolUse?: {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
  }[];
  images?: {
    data: string;
    mediaType: string;
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
  INSERT INTO messages (session_id, role, content, tool_use, images, files, is_error, commit_hash, parent_commit_hash, in_progress, tool_results, upload_paths, turn_usage, subagent_events, rolled_back, notice, notice_level, fork_child, code_rollback_hash)
  VALUES (@session_id, @role, @content, @tool_use, @images, @files, @is_error, @commit_hash, @parent_commit_hash, @in_progress, @tool_results, @upload_paths, @turn_usage, @subagent_events, @rolled_back, @notice, @notice_level, @fork_child, @code_rollback_hash)
`;

const UPDATE_SQL = `
  UPDATE messages SET role=@role, content=@content, tool_use=@tool_use, images=@images,
    files=@files, is_error=@is_error, commit_hash=@commit_hash, parent_commit_hash=@parent_commit_hash,
    in_progress=@in_progress, tool_results=@tool_results, upload_paths=@upload_paths,
    turn_usage=@turn_usage, subagent_events=@subagent_events, rolled_back=@rolled_back,
    notice=@notice, notice_level=@notice_level, fork_child=@fork_child, code_rollback_hash=@code_rollback_hash
  WHERE id = @id
`;

export class ChatHistoryManager {
  private db;
  private stmtInsert;
  private stmtUpdate;
  private stmtLoadAll;
  private stmtLoadLast;
  private stmtDeleteBySession;
  private stmtDeleteInProgress;
  private stmtFinalizeInProgress;

  constructor(dbManager: DatabaseManager) {
    this.db = dbManager.db;
    this.stmtInsert = this.db.prepare(INSERT_SQL);
    this.stmtUpdate = this.db.prepare(UPDATE_SQL);
    this.stmtLoadAll = this.db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id");
    this.stmtLoadLast = this.db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1");
    this.stmtDeleteBySession = this.db.prepare("DELETE FROM messages WHERE session_id = ?");
    this.stmtDeleteInProgress = this.db.prepare("DELETE FROM messages WHERE session_id = ? AND in_progress = 1");
    this.stmtFinalizeInProgress = this.db.prepare("UPDATE messages SET in_progress = 0 WHERE session_id = ? AND in_progress = 1");
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

  /** Update the last message in a session's history by merging fields. */
  updateLastMessage(sessionId: string, update: Partial<PersistedMessage>): void {
    this.db.transaction(() => {
      const lastRow = this.stmtLoadLast.get(sessionId) as MessageRow | undefined;
      if (!lastRow) return;

      const last = this.fromRow(lastRow);
      Object.assign(last, update);
      const row = this.toRow(sessionId, last);
      this.stmtUpdate.run({ ...row, id: lastRow.id });
    })();
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

  /**
   * Replace all in-progress messages for a session with the given set.
   * Called at each agent_tool_result boundary with the accumulated message groups.
   */
  replaceInProgress(sessionId: string, messages: PersistedMessage[]): void {
    this.db.transaction(() => {
      this.stmtDeleteInProgress.run(sessionId);
      for (const msg of messages) {
        this.stmtInsert.run(this.toRow(sessionId, msg));
      }
    })();
  }

  /** Remove the inProgress flag from all messages. Called on agent_result. */
  finalizeInProgress(sessionId: string): void {
    this.stmtFinalizeInProgress.run(sessionId);
  }

  /** Remove all in-progress messages. Called on agent error/abort. */
  clearInProgress(sessionId: string): void {
    this.stmtDeleteInProgress.run(sessionId);
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
