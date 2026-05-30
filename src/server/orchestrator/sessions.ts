import type { ProviderRouteKind, SessionInfo } from "../shared/types.js";
import type { DatabaseManager } from "../shared/database.js";
import type { PrStatusSummary } from "../shared/types/github-types.js";
import type { AgentId } from "../shared/types/agent-types.js";

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
  merged_at: string | null;
  model: string | null;
  agent_id: string | null;
  /** docs/138 — set once the session has taken its first turn (agent pinned). */
  agent_pinned: number;
  provider_route_kind: string | null;
  provider_route_id: string | null;
  pr_status: string | null;
  /** docs/117 — set when the session was spawned by another via `shipit session create`. */
  parent_session_id: string | null;
  /** docs/117 — message-group id of the parent turn that spawned this session. */
  spawned_by_turn: string | null;
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
      remoteUrl: row.remote_url ?? "",
    };
    if (row.agent_session_id) info.agentSessionId = row.agent_session_id;
    if (row.workspace_dir) info.workspaceDir = row.workspace_dir;
    if (row.conversation_replay) info.conversationReplay = row.conversation_replay;
    if (row.archived) info.archived = true;
    if (row.warm) info.warm = true;
    if (row.branch) info.branch = row.branch;
    if (row.branch_renamed) info.branchRenamed = true;
    if (row.merged_at) info.mergedAt = row.merged_at;
    if (row.model) info.model = row.model;
    if (row.agent_id === "claude" || row.agent_id === "codex") info.agentId = row.agent_id;
    if (row.agent_pinned) info.agentPinned = true;
    if ((row.provider_route_kind === "account" || row.provider_route_kind === "reserved") && row.provider_route_id) {
      info.providerRouteKind = row.provider_route_kind;
      info.providerRouteId = row.provider_route_id;
    }
    if (row.parent_session_id) info.parentSessionId = row.parent_session_id;
    if (row.spawned_by_turn) info.spawnedByTurn = row.spawned_by_turn;
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

  /**
   * Reset the session's `created_at` to the current time. Called after
   * workspace setup completes (e.g. clone, refresh) so the session's recorded
   * creation time reflects when it became usable rather than when the warm
   * row was pre-inserted (warm-pool warming inserts the row before the clone
   * writes files). The docs viewer's "modified in this session" detection is
   * now git-based (see `getSessionChangedPaths`), so it no longer depends on
   * this reset, but keeping `created_at` post-setup still makes the sidebar's
   * displayed creation time meaningful.
   */
  markStarted(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      "UPDATE sessions SET created_at = ?, last_used_at = ? WHERE id = ?",
    ).run(now, now, id);
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

  /** Mark a session as merged (sets merged_at timestamp). */
  markMerged(id: string): boolean {
    const result = this.db.prepare(
      "UPDATE sessions SET merged_at = datetime('now') WHERE id = ? AND merged_at IS NULL",
    ).run(id);
    return result.changes > 0;
  }

  /** List merged-but-not-archived sessions, most recently merged first. */
  listMergedNotArchived(): SessionInfo[] {
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE merged_at IS NOT NULL AND archived = 0 ORDER BY merged_at DESC",
    ).all() as SessionRow[];
    return rows.map((r) => this.fromRow(r));
  }

  /**
   * List merged-but-not-archived sessions scoped to a single repository,
   * most recently merged first.
   */
  listMergedNotArchivedByRemoteUrl(remoteUrl: string): SessionInfo[] {
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE merged_at IS NOT NULL AND archived = 0 AND remote_url = ? ORDER BY merged_at DESC",
    ).all(remoteUrl) as SessionRow[];
    return rows.map((r) => this.fromRow(r));
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

  /** Set the branch name on a session. */
  setBranch(id: string, branch: string): void {
    this.db.prepare(
      "UPDATE sessions SET branch = ? WHERE id = ?",
    ).run(branch, id);
  }

  /** Store the selected model for a session. */
  setModel(id: string, model: string): void {
    this.db.prepare("UPDATE sessions SET model = ? WHERE id = ?").run(model, id);
  }

  /** Store the selected agent (provider) for a session. */
  setAgentId(id: string, agentId: AgentId): void {
    this.db.prepare("UPDATE sessions SET agent_id = ? WHERE id = ?").run(agentId, id);
  }

  /**
   * docs/138 — pin the agent for a session. Called when the first turn starts,
   * after the agent's credentials have been provisioned into the per-session
   * credentials directory. Once pinned, `set_agent` is rejected server-side and
   * credential provisioning is skipped (write-once).
   */
  setAgentPinned(id: string): void {
    this.db.prepare("UPDATE sessions SET agent_pinned = 1 WHERE id = ?").run(id);
  }

  setProviderRoute(id: string, kind: ProviderRouteKind, routeId: string): void {
    this.db.prepare(
      "UPDATE sessions SET provider_route_kind = ?, provider_route_id = ? WHERE id = ?",
    ).run(kind, routeId, id);
  }

  /**
   * docs/117 — record that this session was spawned by another session.
   * `spawnedByTurn` is optional context for "list children spawned in the
   * current turn" sorting; pass `undefined` if the caller doesn't have a
   * turn id handy.
   */
  setParentSession(id: string, parentSessionId: string, spawnedByTurn?: string): void {
    this.db.prepare(
      "UPDATE sessions SET parent_session_id = ?, spawned_by_turn = ? WHERE id = ?",
    ).run(parentSessionId, spawnedByTurn ?? null, id);
  }

  /**
   * docs/117 — return every non-archived session whose `parent_session_id`
   * matches the given parent. Sorted most-recently-spawned first so the
   * sidebar's "spawned in this turn" group naturally bubbles to the top.
   *
   * Used by:
   *   - the `shipit session list` shim subcommand (scopes by the calling
   *     worker's session id so a parent agent only ever sees children it
   *     actually spawned),
   *   - the sidebar's "spawned by parent" grouping rendering.
   */
  findChildren(parentSessionId: string): SessionInfo[] {
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE parent_session_id = ? AND archived = 0 ORDER BY last_used_at DESC, rowid DESC",
    ).all(parentSessionId) as SessionRow[];
    return rows.map((r) => this.fromRow(r));
  }

  /**
   * Persist the PR status snapshot for a session. Stored as JSON so archived
   * sessions can keep their PR badge / number / URL across server restarts.
   * Pass `null` to clear the snapshot (e.g., on unarchive when the session
   * starts a fresh branch).
   */
  setPrStatus(id: string, status: PrStatusSummary | null): void {
    const json = status === null ? null : JSON.stringify(status);
    this.db.prepare("UPDATE sessions SET pr_status = ? WHERE id = ?").run(json, id);
  }

  /**
   * Load every persisted PR status snapshot, including archived sessions.
   * Used by the PR poller to seed in-memory `lastKnown` on startup so SSE
   * consumers see PR badges for archived sessions immediately after restart.
   */
  getAllPrStatuses(): PrStatusSummary[] {
    const rows = this.db.prepare(
      "SELECT pr_status FROM sessions WHERE pr_status IS NOT NULL",
    ).all() as { pr_status: string }[];
    const out: PrStatusSummary[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.pr_status) as PrStatusSummary);
      } catch {
        // Corrupt/legacy JSON — skip rather than crash startup.
      }
    }
    return out;
  }
}
