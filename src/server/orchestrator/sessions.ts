import type { SessionInfo } from "../shared/types.js";
import type { DatabaseManager } from "../shared/database.js";

interface SessionRow {
  id: string;
  agent_session_id: string | null;
  title: string;
  created_at: string;
  last_used_at: string;
  workspace_dir: string | null;
  remote_url: string | null;
  conversation_replay: string | null;
  archived: number;
  warm: number;
  branch: string | null;
  session_type: string | null;
  branch_renamed: number;
}

export class SessionManager {
  private db;

  constructor(dbManager: DatabaseManager) {
    this.db = dbManager.db;
  }

  private fromRow(row: SessionRow): SessionInfo {
    const info: SessionInfo = {
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    };
    if (row.agent_session_id) info.agentSessionId = row.agent_session_id;
    if (row.workspace_dir) info.workspaceDir = row.workspace_dir;
    if (row.remote_url) info.remoteUrl = row.remote_url;
    if (row.conversation_replay) info.conversationReplay = row.conversation_replay;
    if (row.archived) info.archived = true;
    if (row.warm) info.warm = true;
    if (row.branch) info.branch = row.branch;
    if (row.session_type) info.sessionType = row.session_type as SessionInfo["sessionType"];
    if (row.branch_renamed) info.branchRenamed = true;
    return info;
  }

  /** List all non-archived, non-warm sessions, most recently used first. */
  list(): SessionInfo[] {
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE archived = 0 AND warm = 0 ORDER BY last_used_at DESC, rowid DESC",
    ).all() as SessionRow[];
    return rows.map((r) => this.fromRow(r));
  }

  /** All session IDs including warm and archived — for container lifecycle decisions. */
  allIds(): string[] {
    const rows = this.db.prepare("SELECT id FROM sessions").all() as { id: string }[];
    return rows.map((r) => r.id);
  }

  /** Find a warm (ungraduated) session for a repo URL, excluding a specific ID. */
  findUngraduatedWarm(repoUrl: string, excludeId?: string): SessionInfo | undefined {
    const row = this.db.prepare(
      "SELECT * FROM sessions WHERE warm = 1 AND remote_url = ? AND id != ?",
    ).get(repoUrl, excludeId ?? "") as SessionRow | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  /** Get a session by id. Returns undefined if not found. */
  get(id: string): SessionInfo | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  /** Track a session — creates it if new, updates lastUsedAt if existing. */
  track(id: string, title?: string, workspaceDir?: string): SessionInfo {
    const now = new Date().toISOString();
    const existing = this.get(id);
    if (existing) {
      const updates: string[] = ["last_used_at = ?"];
      const params: unknown[] = [now];
      if (title) {
        updates.push("title = ?");
        params.push(title);
      }
      if (workspaceDir && !existing.workspaceDir) {
        updates.push("workspace_dir = ?");
        params.push(workspaceDir);
      }
      params.push(id);
      this.db.prepare(`UPDATE sessions SET ${updates.join(", ")} WHERE id = ?`).run(...params);
      return this.get(id)!;
    }

    this.db.prepare(`
      INSERT INTO sessions (id, title, created_at, last_used_at, workspace_dir)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, title || "New session", now, now, workspaceDir ?? null);
    return this.get(id)!;
  }

  /** Store the agent's conversation ID for a session. */
  setAgentSessionId(id: string, agentSessionId: string): void {
    this.db.prepare("UPDATE sessions SET agent_session_id = ? WHERE id = ?").run(agentSessionId, id);
  }

  /** Store conversation replay text for injection after a rollback. */
  setConversationReplay(id: string, replay: string): void {
    this.db.prepare("UPDATE sessions SET conversation_replay = ? WHERE id = ?").run(replay, id);
  }

  /** Consume (read + clear) conversation replay for a session. */
  consumeConversationReplay(id: string): string | undefined {
    let replay: string | undefined;
    this.db.transaction(() => {
      const row = this.db.prepare(
        "SELECT conversation_replay FROM sessions WHERE id = ?",
      ).get(id) as { conversation_replay: string | null } | undefined;
      if (row?.conversation_replay) {
        this.db.prepare("UPDATE sessions SET conversation_replay = NULL WHERE id = ?").run(id);
        replay = row.conversation_replay;
      }
    })();
    return replay;
  }

  /** Clear the agent session ID for a session. */
  clearAgentSessionId(id: string): void {
    this.db.prepare("UPDATE sessions SET agent_session_id = NULL WHERE id = ?").run(id);
  }

  /** Cache the origin remote URL for a session. */
  setRemoteUrl(id: string, remoteUrl: string | undefined): void {
    this.db.prepare("UPDATE sessions SET remote_url = ? WHERE id = ?").run(remoteUrl ?? null, id);
  }

  /** Rename a session. Returns the updated session, or null if not found. */
  rename(id: string, title: string): SessionInfo | null {
    const result = this.db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(title, id);
    if (result.changes === 0) return null;
    return this.get(id) ?? null;
  }

  /** Archive a session. */
  archive(id: string): boolean {
    const result = this.db.prepare("UPDATE sessions SET archived = 1 WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /** Unarchive a session. */
  unarchive(id: string): boolean {
    const row = this.db.prepare("SELECT archived FROM sessions WHERE id = ?").get(id) as { archived: number } | undefined;
    if (!row?.archived) return false;
    this.db.prepare("UPDATE sessions SET archived = 0 WHERE id = ?").run(id);
    return true;
  }

  /** List all archived sessions, most recently used first. */
  listArchived(): SessionInfo[] {
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE archived = 1 ORDER BY last_used_at DESC, rowid DESC",
    ).all() as SessionRow[];
    return rows.map((r) => this.fromRow(r));
  }

  /** List all non-warm sessions (active + archived), most recently used first. */
  listAll(): SessionInfo[] {
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE warm = 0 ORDER BY last_used_at DESC, rowid DESC",
    ).all() as SessionRow[];
    return rows.map((r) => this.fromRow(r));
  }

  /** Clear all session data. */
  clear(): void {
    this.db.prepare("DELETE FROM sessions").run();
  }

  /** Delete a session by id. */
  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /** Set or clear the warm flag on a session. */
  setWarm(id: string, warm: boolean): void {
    this.db.prepare("UPDATE sessions SET warm = ? WHERE id = ?").run(warm ? 1 : 0, id);
  }

  /** Find all non-archived sessions with the given remote URL. */
  findAllByRemoteUrl(remoteUrl: string): SessionInfo[] {
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE remote_url = ? AND archived = 0",
    ).all(remoteUrl) as SessionRow[];
    return rows.map((r) => this.fromRow(r));
  }

  /** Mark a session's branch as renamed. */
  setBranchRenamed(id: string, renamed: boolean): void {
    this.db.prepare("UPDATE sessions SET branch_renamed = ? WHERE id = ?").run(renamed ? 1 : 0, id);
  }

  /** Set branch and session type on a session. */
  setWorktreeInfo(id: string, info: { branch: string; sessionType: "worktree" }): void {
    this.db.prepare(
      "UPDATE sessions SET branch = ?, session_type = ? WHERE id = ?",
    ).run(info.branch, info.sessionType, id);
  }
}
