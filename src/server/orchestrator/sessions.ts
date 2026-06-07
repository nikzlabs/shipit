import type { ProviderRouteKind, SessionInfo } from "../shared/types.js";
import { parseTimestampMs } from "../shared/utils.js";
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
  /** docs/161 — 'hot' | 'light' | 'evicted'. How much is on disk right now. */
  disk_tier: string;
  /** docs/161 — explicit "hide from sidebar" action. */
  user_archived: number;
  /** docs/161 — bumped on viewer attach; read only by the disk-idle ladder. */
  last_viewed_at: string | null;
  warm: number;
  branch: string | null;
  session_type: string | null;
  /** docs/128 — server-authoritative session kind ("ops" or null). */
  kind: string | null;
  branch_renamed: number;
  merged_at: string | null;
  closed_at: string | null;
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

/** Maximum number of merged sessions shown per repository in the sidebar. */
export const MAX_MERGED_SESSIONS_PER_REPO = 3;

/**
 * docs/161 — disk-idle ladder thresholds. "Idle age" for the ladder is
 * `now - max(Date.parse(lastUsedAt), Date.parse(lastViewedAt))` — turn activity
 * OR a recent viewer attach keeps a session warm. These are the defaults; the
 * orchestrator may override them from env (see `index.ts`). The disk-pressure
 * pass can escalate before these elapse when free space crosses the low-water
 * mark (LRU), so they're deliberately generous.
 */
export const IDLE_LIGHT_MS = 24 * 60 * 60 * 1000; // 24h: hot → light (drop deps)
export const IDLE_EVICT_MS = 14 * 24 * 60 * 60 * 1000; // 14d: light → evicted (wipe checkout)
/**
 * docs/161 — merge-aware eviction. A merged PR is a much stronger "done" signal
 * than idle age: the work shipped and the checkout re-fetches fresh on reopen,
 * so finished sessions can be reclaimed far sooner than unmerged WIP (which
 * stays on the gentle `IDLE_EVICT_MS` clock). 2 days after last touch.
 */
export const IDLE_EVICT_MERGED_MS = 2 * 24 * 60 * 60 * 1000; // 2d: merged light → evicted

/**
 * The instant a session's PR reached a terminal state — merged or
 * closed-without-merge. Both sink the session out of the active sidebar into the
 * demoted "Recently resolved" group; `mergedAt` wins if somehow both are set
 * (a merge is the stronger outcome). Returns undefined for a session whose PR is
 * still open (or that never had one).
 */
export function resolvedAt(s: SessionInfo): string | undefined {
  return s.mergedAt ?? s.closedAt;
}

/**
 * docs/161 — true when a *resolved* session (merged or closed) has been
 * *worked in* since it resolved, i.e. the user returned to it to start a
 * follow-up PR. Keys on `lastUsedAt` (bumped only by turn activity, never by
 * merely opening the session), so it becomes true the instant the user sends a
 * message in a resolved session, floating it back into the Active group.
 *
 * Evaluated in JS, not SQL: `merged_at`/`closed_at` are written by
 * `datetime('now')` ("YYYY-MM-DD HH:MM:SS") while `last_used_at` is
 * `toISOString()` ("…THH:MM:SS.sssZ"). A lexical `>` is wrong — 'T' (0x54) >
 * ' ' (0x20), so an ISO timestamp at the same wall-clock second always sorts
 * greater, falsely marking a just-resolved session as reopened.
 * `parseTimestampMs` reconciles the two formats to UTC epoch ms — a plain
 * `Date.parse` would read the suffix-less SQLite form as *local* time and
 * mis-order the two on any non-UTC runtime.
 */
export function reopenedAfterResolve(s: SessionInfo): boolean {
  const resolved = resolvedAt(s);
  if (!resolved) return false;
  const resolvedMs = parseTimestampMs(resolved);
  const used = parseTimestampMs(s.lastUsedAt);
  if (Number.isNaN(resolvedMs) || Number.isNaN(used)) return false;
  return used > resolvedMs;
}

/**
 * docs/161 — the sidebar visibility predicate. Pure derivation over session
 * metadata; `diskTier` is deliberately NOT consulted (a disk-evicted but recent
 * session stays listed and restores on select). Input must already exclude
 * warm sessions but MAY include user-archived ones — they are filtered out of
 * the result here, yet still count toward the per-repo resolved ranking (see
 * below). "Resolved" means a terminal PR state — merged OR closed-without-merge;
 * both demote a session out of Active. A session is visible when it is NOT
 * user-archived and is:
 *   - active (PR still open or never had one), or
 *   - resolved but reopened (worked in since the merge/close), or
 *   - among the top-N most-recently-resolved for its repo (the view cap).
 * Exceeding the cap only removes it from the sidebar — zero disk consequence.
 *
 * The resolved ranking deliberately INCLUDES user-archived resolved sessions so an
 * archived session keeps occupying its chronological slot. This makes manual
 * archiving feel right: archiving one of the N visible merged sessions lowers
 * the visible count to N-1 instead of promoting an older, previously-demoted
 * session into the freed slot. The slot self-heals as newer PRs merge and push
 * the archived session past rank N.
 *
 * Parent/child exemption (docs/117): the merged view cap is a form of *automatic*
 * archiving, and spawned parent/child clusters are exempt from it — they only
 * leave the sidebar via an explicit user archive (which `archiveSession`
 * cascades from parent to children). Concretely, the cap never demotes:
 *   - a session that still has a live (non-user-archived) child — a parent with
 *     children is only ever archived manually, and
 *   - a child whose parent is still live — a child is only archived together
 *     with its parent, never on its own.
 * Both exemptions only rescue a session that the cap would otherwise drop;
 * user-archived sessions are still excluded, so the manual cascade is unaffected.
 */
export function filterVisibleInSidebar(
  sessions: SessionInfo[],
  maxMerged = MAX_MERGED_SESSIONS_PER_REPO,
): SessionInfo[] {
  // Rank resolved-not-reopened sessions (merged OR closed) per repo by resolve
  // time desc; keep top N. Archived sessions are included in the ranking (so
  // they hold their slot) but dropped from the output by the `!s.userArchived`
  // guard at the end.
  const resolvedByRepo = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    if (!resolvedAt(s) || reopenedAfterResolve(s)) continue;
    const key = s.remoteUrl ?? "";
    let group = resolvedByRepo.get(key);
    if (!group) {
      group = [];
      resolvedByRepo.set(key, group);
    }
    group.push(s);
  }
  const topResolvedIds = new Set<string>();
  for (const group of resolvedByRepo.values()) {
    group.sort((a, b) => (Date.parse(resolvedAt(b) ?? "") || 0) - (Date.parse(resolvedAt(a) ?? "") || 0));
    for (const s of group.slice(0, maxMerged)) topResolvedIds.add(s.id);
  }
  // Parent/child relationships are derived from the (non-archived) sessions in
  // this same list: a live child both proves its parent has children and marks
  // its parent as live. User-archived sessions don't count — an archived child
  // shouldn't pin its parent open, and an archived parent shouldn't pin its
  // children open (the cascade has its own path).
  const liveIds = new Set<string>();
  const parentsWithLiveChildren = new Set<string>();
  for (const s of sessions) {
    if (s.userArchived) continue;
    liveIds.add(s.id);
    if (s.parentSessionId) parentsWithLiveChildren.add(s.parentSessionId);
  }
  const exemptFromCap = (s: SessionInfo): boolean =>
    parentsWithLiveChildren.has(s.id) ||
    (s.parentSessionId !== undefined && liveIds.has(s.parentSessionId));
  return sessions.filter(
    (s) =>
      !s.userArchived &&
      (!resolvedAt(s) || reopenedAfterResolve(s) || topResolvedIds.has(s.id) || exemptFromCap(s)),
  );
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
    info.diskTier = row.disk_tier === "light" || row.disk_tier === "evicted" ? row.disk_tier : "hot";
    if (row.user_archived) {
      info.userArchived = true;
      // Back-compat: `archived` now means "user explicitly hid it".
      info.archived = true;
    }
    if (row.last_viewed_at) info.lastViewedAt = row.last_viewed_at;
    if (row.warm) info.warm = true;
    if (row.branch) info.branch = row.branch;
    if (row.kind === "ops") info.kind = "ops";
    if (row.branch_renamed) info.branchRenamed = true;
    if (row.merged_at) info.mergedAt = row.merged_at;
    if (row.closed_at) info.closedAt = row.closed_at;
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

  /**
   * docs/161 — sessions shown in the active sidebar. No longer keyed on the
   * legacy `archived` flag: returns non-warm, non-user-archived sessions that
   * satisfy `filterVisibleInSidebar` (active, reopened-merged, or within the
   * per-repo merged view cap). Disk tier is irrelevant to visibility.
   *
   * We fetch user-archived rows too (the SQL only drops warm sessions) and let
   * `filterVisibleInSidebar` exclude them: archived merged sessions must still
   * count toward the per-repo merged ranking so archiving a visible session
   * doesn't promote a previously-demoted one into the freed slot.
   */
  list(): SessionInfo[] {
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE warm = 0 ORDER BY last_used_at DESC, rowid DESC",
    ).all() as SessionRow[];
    return filterVisibleInSidebar(rows.map((r) => this.fromRow(r)));
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

  /**
   * Hide a session from the sidebar and reclaim its disk (docs/161). Sets the
   * explicit `user_archived` flag and drops `disk_tier` to `evicted` (the
   * caller wipes the workspace). The legacy `archived` column is left untouched
   * — it is no longer read by application code.
   */
  archive(id: string): boolean {
    const result = this.db.prepare(
      "UPDATE sessions SET user_archived = 1, disk_tier = 'evicted' WHERE id = ?",
    ).run(id);
    return result.changes > 0;
  }

  /**
   * Restore a session to the sidebar and mark it back on disk (docs/161).
   * Restorable when it was user-hidden OR disk-evicted; the caller re-clones
   * the workspace. Returns false when neither applies (nothing to restore).
   */
  unarchive(id: string): boolean {
    const row = this.db.prepare(
      "SELECT user_archived, disk_tier FROM sessions WHERE id = ?",
    ).get(id) as { user_archived: number; disk_tier: string } | undefined;
    if (!row || (!row.user_archived && row.disk_tier !== "evicted")) return false;
    this.db.prepare(
      "UPDATE sessions SET user_archived = 0, disk_tier = 'hot' WHERE id = ?",
    ).run(id);
    return true;
  }

  /** Mark a session as merged (sets merged_at timestamp). */
  markMerged(id: string): boolean {
    const result = this.db.prepare(
      "UPDATE sessions SET merged_at = datetime('now') WHERE id = ? AND merged_at IS NULL",
    ).run(id);
    return result.changes > 0;
  }

  /**
   * Mark a session's PR as closed without a merge (sets closed_at timestamp).
   * No-op if the PR already merged — a merge is the stronger terminal state and
   * must not be downgraded to "closed". Unlike `markMerged` this does NOT delete
   * the head branch or trigger aggressive disk reclaim: a closed PR can be
   * reopened, so we keep the branch and the gentle idle clock.
   */
  markClosed(id: string): boolean {
    const result = this.db.prepare(
      "UPDATE sessions SET closed_at = datetime('now') WHERE id = ? AND closed_at IS NULL AND merged_at IS NULL",
    ).run(id);
    return result.changes > 0;
  }

  /** List merged, not-user-hidden sessions, most recently merged first. */
  listMergedNotArchived(): SessionInfo[] {
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE merged_at IS NOT NULL AND user_archived = 0 ORDER BY merged_at DESC",
    ).all() as SessionRow[];
    return rows.map((r) => this.fromRow(r));
  }

  /**
   * List merged, not-user-hidden sessions scoped to a single repository,
   * most recently merged first.
   */
  listMergedNotArchivedByRemoteUrl(remoteUrl: string): SessionInfo[] {
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE merged_at IS NOT NULL AND user_archived = 0 AND remote_url = ? ORDER BY merged_at DESC",
    ).all(remoteUrl) as SessionRow[];
    return rows.map((r) => this.fromRow(r));
  }

  /**
   * docs/161 — sessions whose workspace has been reclaimed (`disk_tier =
   * 'evicted'`). The disk-janitor uses this for its credential/workspace
   * backstop sweeps and to exclude evicted sessions' branches from the
   * live-branch set. (User-hidden sessions are always evicted, so they are
   * included; a still-on-disk session, listed or not, is never returned.)
   */
  listArchived(): SessionInfo[] {
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE disk_tier = 'evicted' ORDER BY last_used_at DESC, rowid DESC",
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

  /**
   * Find all sessions with the given remote URL, including evicted/hidden ones.
   * Callers (branch-collision avoidance, repo-wide bookkeeping) must see every
   * session that still owns a branch, not just the sidebar-visible subset.
   */
  findAllByRemoteUrl(remoteUrl: string): SessionInfo[] {
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE remote_url = ?",
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

  /**
   * docs/161 — set the on-disk tier without touching visibility. Used by the
   * disk-idle ladder (`hot → light → evicted`) and by restore (`light/evicted →
   * hot`). Orthogonal to `user_archived`: changing disk tier never hides or
   * un-hides a session.
   */
  setDiskTier(id: string, tier: "hot" | "light" | "evicted"): void {
    this.db.prepare("UPDATE sessions SET disk_tier = ? WHERE id = ?").run(tier, id);
  }

  /**
   * docs/161 — bump the viewer clock. Read ONLY by the disk-idle ladder
   * (`max(lastUsedAt, lastViewedAt)`), never by the listing predicate — so
   * merely opening a merged session keeps its disk warm without promoting it to
   * Active (which keys off `last_used_at`, bumped only by turn activity).
   */
  setLastViewedAt(id: string, iso?: string): void {
    this.db.prepare("UPDATE sessions SET last_viewed_at = ? WHERE id = ?")
      .run(iso ?? new Date().toISOString(), id);
  }

  /**
   * docs/128 — set the server-authoritative session kind. Currently only
   * `"ops"` is meaningful; it is the gate for the privileged journal mounts +
   * read-only Docker proxy in container creation. Set once at creation by the
   * gated ops template route; the container cannot flip it.
   */
  setKind(id: string, kind: "ops"): void {
    this.db.prepare("UPDATE sessions SET kind = ? WHERE id = ?").run(kind, id);
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
   * docs/117 — return every non-user-archived session whose `parent_session_id`
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
      "SELECT * FROM sessions WHERE parent_session_id = ? AND user_archived = 0 ORDER BY last_used_at DESC, rowid DESC",
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
    // A previously-closed PR observed open again has been reopened: clear the
    // terminal `closed_at` so the session immediately rejoins the Active group
    // (it would otherwise linger in "Recently resolved" until the next turn
    // bumped `last_used_at` past the close). Merges are not reopenable, so
    // `merged_at` is intentionally left untouched.
    if (status?.prState === "open") {
      this.db.prepare(
        "UPDATE sessions SET closed_at = NULL WHERE id = ? AND closed_at IS NOT NULL",
      ).run(id);
    }
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
