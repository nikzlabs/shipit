import type { DatabaseManager } from "../shared/database.js";

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
  created_at: string;
}

const INSERT_SQL = `
  INSERT INTO messages (session_id, role, content, tool_use, images, files, is_error, commit_hash, parent_commit_hash, in_progress, tool_results)
  VALUES (@session_id, @role, @content, @tool_use, @images, @files, @is_error, @commit_hash, @parent_commit_hash, @in_progress, @tool_results)
`;

const UPDATE_SQL = `
  UPDATE messages SET role=@role, content=@content, tool_use=@tool_use, images=@images,
    files=@files, is_error=@is_error, commit_hash=@commit_hash, parent_commit_hash=@parent_commit_hash,
    in_progress=@in_progress, tool_results=@tool_results
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
    return msg;
  }

  /** Append a message to a session's history. */
  append(sessionId: string, message: PersistedMessage): void {
    this.stmtInsert.run(this.toRow(sessionId, message));
  }

  /** Load all messages for a session. Returns [] if none exist. */
  load(sessionId: string): PersistedMessage[] {
    const rows = this.stmtLoadAll.all(sessionId) as MessageRow[];
    return rows.map((r) => this.fromRow(r));
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
