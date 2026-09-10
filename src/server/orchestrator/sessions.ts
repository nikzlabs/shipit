import type { PreviousMergedPr, ProviderRouteKind, SessionCapabilities, SessionInfo, SessionMergeWatch, SessionSecretBlock, SessionTitleSource } from "../shared/types.js";
import { normalizeCapabilities } from "../shared/types.js";
import { isTerminalPrResolved, resolvedAt } from "../shared/session-resolution.js";
import type { DatabaseManager } from "../shared/database.js";
import type { PrStatusSummary } from "../shared/types/github-types.js";
import type { AgentId } from "../shared/types/agent-types.js";
import type { BillingMode, ModelSelection } from "../shared/catalogue/index.js";
import { resolveModelSelection, sameCredentialOwner } from "../shared/catalogue/index.js";
import { repoId, stripRemoteUrlCredentials } from "./git-utils.js";

// Bill by the actual route, which can differ from the session's requested mode.
export function billingModeForRoute(
  kind: ProviderRouteKind,
  routeId: string,
): BillingMode | undefined {
  if (kind === "account") return "sub";
  if (routeId === "claude-env-oauth") return "sub";
  if (routeId === "claude-api-key" || routeId === "codex-api-key") return "key";
  return undefined;
}

interface SessionRow {
  id: string;
  agent_session_id: string | null;
  title: string;
  title_source: string | null;
  created_at: string;
  last_used_at: string;
  workspace_dir: string | null;
  remote_url: string | null;
  conversation_replay: string | null;
  archived: number;
  disk_tier: string;
  user_archived: number;
  last_viewed_at: string | null;
  warm: number;
  branch: string | null;
  session_type: string | null;
  kind: string | null;
  capabilities: string | null;
  branch_renamed: number;
  merged_at: string | null;
  closed_at: string | null;
  model: string | null;
  reasoning_effort: string | null;
  agent_id: string | null;
  agent_pinned: number;
  provider_route_kind: string | null;
  provider_route_id: string | null;
  service_id: string | null;
  billing_mode: string | null;
  provider_route_service_id: string | null;
  provider_route_billing_mode: string | null;
  pr_status: string | null;
  parent_session_id: string | null;
  spawned_by_turn: string | null;
  root_session_id: string | null;
  origin_role_name: string | null;
  role_name: string | null;
  last_turn_errored: number;
  auto_fix_ci_paused: number;
  pinned_at: string | null;
  keep_preview_running: number;
  muted_at: string | null;
  merge_watch: string | null;
  secret_block: string | null;
  merge_issue_effects: string | null;
  previous_merged_pr: string | null;
  merged_head_sha: string | null;
  pending_agent_notice: string | null;
  pr_repo_id: string | null;
  pr_number: number | null;
}

export const MAX_MERGED_SESSIONS_PER_REPO = 5;

function safeParseCapabilities(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

export interface DiskLadderThresholds {
  lightAfterMs: number;
  evictMergedAfterMs: number;
  evictUnmergedAfterMs: number;
}

export const DEFAULT_DISK_LADDER: DiskLadderThresholds = {
  lightAfterMs: 24 * 60 * 60 * 1000,
  evictMergedAfterMs: 2 * 24 * 60 * 60 * 1000,
  evictUnmergedAfterMs: 14 * 24 * 60 * 60 * 1000,
};

export function assertDiskLadderOrdering(t: DiskLadderThresholds): void {
  if (!(t.lightAfterMs <= t.evictMergedAfterMs && t.evictMergedAfterMs <= t.evictUnmergedAfterMs)) {
    throw new Error(
      "Incoherent disk-ladder thresholds: expected "
      + "lightAfterMs ≤ evictMergedAfterMs ≤ evictUnmergedAfterMs, got "
      + `lightAfterMs=${t.lightAfterMs}ms, evictMergedAfterMs=${t.evictMergedAfterMs}ms, `
      + `evictUnmergedAfterMs=${t.evictUnmergedAfterMs}ms`,
    );
  }
}

// Legacy archived rows can retain the flag without owning a reservation.
export function holdsActiveReservation(session: SessionInfo | undefined | null): boolean {
  return !!session?.keepPreviewRunning && !session.userArchived && !session.archived && !session.warm;
}

export function filterVisibleInSidebar(
  sessions: SessionInfo[],
  maxMerged = MAX_MERGED_SESSIONS_PER_REPO,
): SessionInfo[] {
  // Archived rows keep their rank so archiving does not promote an older session.
  const resolvedByRepo = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    if (!isTerminalPrResolved(s)) continue;
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
  // Root ancestry protects the whole spawn tree; roots must not self-reference.
  const liveIds = new Set<string>();
  const liveRoots = new Set<string>();
  for (const s of sessions) {
    if (s.userArchived) continue;
    liveIds.add(s.id);
    if (s.rootSessionId) liveRoots.add(s.rootSessionId);
  }
  const exemptFromCap = (s: SessionInfo): boolean =>
    liveRoots.has(s.id) ||
    (s.rootSessionId !== undefined && liveIds.has(s.rootSessionId));
  return sessions.filter(
    (s) =>
      !s.userArchived &&
      (!!s.pinnedAt
        || holdsActiveReservation(s)
        || !isTerminalPrResolved(s)
        || topResolvedIds.has(s.id)
        || exemptFromCap(s)),
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
    if (row.title_source === "user" || row.title_source === "agent") info.titleSource = row.title_source;
    if (row.agent_session_id) info.agentSessionId = row.agent_session_id;
    if (row.workspace_dir) info.workspaceDir = row.workspace_dir;
    if (row.conversation_replay) info.conversationReplay = row.conversation_replay;
    info.diskTier = row.disk_tier === "light" || row.disk_tier === "evicted" ? row.disk_tier : "hot";
    if (row.user_archived) {
      info.userArchived = true;
      info.archived = true;
    }
    if (row.last_viewed_at) info.lastViewedAt = row.last_viewed_at;
    if (row.warm) info.warm = true;
    if (row.branch) info.branch = row.branch;
    if (row.kind === "ops") info.kind = "ops";
    if (row.kind === "sandbox") {
      info.kind = "sandbox";
      info.capabilities = normalizeCapabilities(
        row.capabilities ? safeParseCapabilities(row.capabilities) : undefined,
      );
    }
    if (row.branch_renamed) info.branchRenamed = true;
    if (row.merged_at) info.mergedAt = row.merged_at;
    if (row.closed_at) info.closedAt = row.closed_at;
    if (row.model) info.model = row.model;
    if (row.reasoning_effort) info.reasoningEffort = row.reasoning_effort;
    if (
      row.agent_id === "claude" || row.agent_id === "codex"
      || row.agent_id === "opencode" || row.agent_id === "grok"
    ) info.agentId = row.agent_id;
    if (row.agent_pinned) info.agentPinned = true;
    // Service/mode and model may be populated independently on legacy selections.
    if (row.service_id) info.serviceId = row.service_id;
    if (row.billing_mode === "sub" || row.billing_mode === "key") info.billingMode = row.billing_mode;
    if ((row.provider_route_kind === "account" || row.provider_route_kind === "reserved") && row.provider_route_id) {
      info.providerRouteKind = row.provider_route_kind;
      info.providerRouteId = row.provider_route_id;
      if (row.provider_route_service_id) info.providerRouteServiceId = row.provider_route_service_id;
      if (row.provider_route_billing_mode === "sub" || row.provider_route_billing_mode === "key") {
        info.providerRouteBillingMode = row.provider_route_billing_mode;
      }
    }
    if (row.parent_session_id) info.parentSessionId = row.parent_session_id;
    if (row.spawned_by_turn) info.spawnedByTurn = row.spawned_by_turn;
    if (row.origin_role_name) info.originRoleName = row.origin_role_name;
    if (row.role_name) info.roleName = row.role_name;
    if (row.root_session_id) info.rootSessionId = row.root_session_id;
    if (row.last_turn_errored) info.lastTurnErrored = true;
    if (row.auto_fix_ci_paused) info.autoFixCiPaused = true;
    if (row.pinned_at) info.pinnedAt = row.pinned_at;
    if (row.keep_preview_running) info.keepPreviewRunning = true;
    if (row.muted_at) info.mutedAt = row.muted_at;
    if (row.merge_watch) {
      try {
        info.mergeWatch = JSON.parse(row.merge_watch) as SessionInfo["mergeWatch"];
      } catch {
        // Ignore corrupt JSON.
      }
    }
    if (row.previous_merged_pr) {
      try {
        info.previousMergedPr = JSON.parse(row.previous_merged_pr) as SessionInfo["previousMergedPr"];
      } catch {
        // Ignore corrupt JSON.
      }
    }
    if (row.secret_block) {
      try {
        info.secretBlock = JSON.parse(row.secret_block) as SessionInfo["secretBlock"];
      } catch {
        // The next auto-commit rescans and restores the block if needed.
      }
    }
    if (row.merged_head_sha) info.mergedHeadSha = row.merged_head_sha;
    if (row.pending_agent_notice) info.pendingAgentNotice = row.pending_agent_notice;
    // Partial provenance must not authorize a merge.
    if (row.pr_number && row.pr_repo_id) {
      info.prNumber = row.pr_number;
      info.prRepoId = row.pr_repo_id;
    }
    return info;
  }

  // Include archived rows for ranking; filterVisibleInSidebar removes them afterwards.
  list(): SessionInfo[] {
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE warm = 0 ORDER BY last_used_at DESC, rowid DESC",
    ).all() as SessionRow[];
    return filterVisibleInSidebar(rows.map((r) => this.fromRow(r)));
  }

  allIds(): string[] {
    const rows = this.db.prepare("SELECT id FROM sessions").all() as { id: string }[];
    return rows.map((r) => r.id);
  }

  findUngraduatedWarm(repoUrl: string, excludeId?: string): SessionInfo | undefined {
    const row = this.db.prepare(
      "SELECT * FROM sessions WHERE warm = 1 AND remote_url = ? AND id != ?",
    ).get(repoUrl, excludeId ?? "") as SessionRow | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  get(id: string): SessionInfo | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return row ? this.fromRow(row) : undefined;
  }

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

  // Record when setup finishes, not when the warm-pool row was inserted.
  markStarted(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      "UPDATE sessions SET created_at = ?, last_used_at = ? WHERE id = ?",
    ).run(now, now, id);
  }

  setAgentSessionId(id: string, agentSessionId: string): void {
    this.db.prepare("UPDATE sessions SET agent_session_id = ? WHERE id = ?").run(agentSessionId, id);
  }

  setConversationReplay(id: string, replay: string): void {
    this.db.prepare("UPDATE sessions SET conversation_replay = ? WHERE id = ?").run(replay, id);
  }

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

  // Branch movement supersedes earlier notices, including appended ones.
  setPendingAgentNotice(id: string, notice: string): void {
    this.db.prepare("UPDATE sessions SET pending_agent_notice = ? WHERE id = ?").run(notice, id);
  }

  appendPendingAgentNotice(id: string, notice: string): void {
    this.db.transaction(() => {
      const row = this.db.prepare(
        "SELECT pending_agent_notice FROM sessions WHERE id = ?",
      ).get(id) as { pending_agent_notice: string | null } | undefined;
      const existing = row?.pending_agent_notice ?? "";
      if (existing.includes(notice)) return;
      const combined = existing ? `${existing}\n\n${notice}` : notice;
      this.db.prepare("UPDATE sessions SET pending_agent_notice = ? WHERE id = ?").run(combined, id);
    })();
  }

  // Read-and-clear prevents repeats; a crash before delivery can lose the notice.
  consumePendingAgentNotice(id: string): string | undefined {
    let notice: string | undefined;
    this.db.transaction(() => {
      const row = this.db.prepare(
        "SELECT pending_agent_notice FROM sessions WHERE id = ?",
      ).get(id) as { pending_agent_notice: string | null } | undefined;
      if (row?.pending_agent_notice) {
        this.db.prepare("UPDATE sessions SET pending_agent_notice = NULL WHERE id = ?").run(id);
        notice = row.pending_agent_notice;
      }
    })();
    return notice;
  }

  clearAgentSessionId(id: string): void {
    this.db.prepare("UPDATE sessions SET agent_session_id = NULL WHERE id = ?").run(id);
  }

  // This URL is later written into agent-readable clone configs.
  setRemoteUrl(id: string, remoteUrl: string | undefined): void {
    const stored = remoteUrl === undefined ? null : stripRemoteUrlCredentials(remoteUrl);
    const previous = this.db
      .prepare("SELECT remote_url FROM sessions WHERE id = ?")
      .get(id) as { remote_url: string | null } | undefined;
    this.db.prepare("UPDATE sessions SET remote_url = ? WHERE id = ?").run(stored, id);
    // Equivalent URL spellings keep provenance; a different repository invalidates it.
    if (previous !== undefined && repoId(previous.remote_url ?? "") !== repoId(stored ?? "")) {
      this.clearPrProvenance(id);
    }
  }

  // Only record PRs ShipIt created, never ones it merely discovered.
  recordPrProvenance(id: string, prNumber: number, repoIdentity: string): void {
    if (!Number.isInteger(prNumber) || prNumber <= 0 || !repoIdentity) return;
    this.db
      .prepare("UPDATE sessions SET pr_number = ?, pr_repo_id = ? WHERE id = ?")
      .run(prNumber, repoIdentity, id);
  }

  clearPrProvenance(id: string): void {
    this.db
      .prepare("UPDATE sessions SET pr_number = NULL, pr_repo_id = NULL WHERE id = ?")
      .run(id);
  }

  // Callers enforce title precedence before entering their naming flow.
  rename(id: string, title: string, source?: SessionTitleSource): SessionInfo | null {
    const result = this.db
      .prepare("UPDATE sessions SET title = ?, title_source = ? WHERE id = ?")
      .run(title, source ?? null, id);
    if (result.changes === 0) return null;
    return this.get(id) ?? null;
  }

  // The caller removes the workspace; hidden sessions release pins and preview capacity.
  archive(id: string): boolean {
    const result = this.db.prepare(
      "UPDATE sessions SET user_archived = 1, disk_tier = 'evicted', pinned_at = NULL, keep_preview_running = 0 WHERE id = ?",
    ).run(id);
    return result.changes > 0;
  }

  unarchive(id: string): boolean {
    const row = this.db.prepare(
      "SELECT user_archived, disk_tier FROM sessions WHERE id = ?",
    ).get(id) as { user_archived: number; disk_tier: string } | undefined;
    if (!row || (!row.user_archived && row.disk_tier !== "evicted")) return false;
    // Another session may now own the preview slot; restore must not reclaim it.
    this.db.prepare(
      "UPDATE sessions SET user_archived = 0, disk_tier = 'hot', keep_preview_running = 0 WHERE id = ?",
    ).run(id);
    return true;
  }

  markMerged(id: string): boolean {
    const result = this.db.prepare(
      "UPDATE sessions SET merged_at = datetime('now') WHERE id = ? AND merged_at IS NULL",
    ).run(id);
    return result.changes > 0;
  }

  setMergedHeadSha(id: string, sha: string): void {
    this.db.prepare("UPDATE sessions SET merged_head_sha = ? WHERE id = ?").run(sha, id);
  }

  clearMerged(id: string, previousMergedPr: PreviousMergedPr | null): boolean {
    const json = previousMergedPr === null ? null : JSON.stringify(previousMergedPr);
    const result = this.db.prepare(
      "UPDATE sessions SET merged_at = NULL, previous_merged_pr = ?, merged_head_sha = NULL, "
      + "pr_number = NULL, pr_repo_id = NULL WHERE id = ? AND merged_at IS NOT NULL",
    ).run(json, id);
    return result.changes > 0;
  }

  // Pair with PrStatusPoller.clearPersisted when replacing the branch on unarchive.
  clearPriorPrRecord(id: string): void {
    this.db.prepare(
      "UPDATE sessions SET merged_at = NULL, merged_head_sha = NULL, previous_merged_pr = NULL, "
      + "pr_number = NULL, pr_repo_id = NULL WHERE id = ?",
    ).run(id);
  }

  markClosed(id: string): boolean {
    const result = this.db.prepare(
      "UPDATE sessions SET closed_at = datetime('now') WHERE id = ? AND closed_at IS NULL AND merged_at IS NULL",
    ).run(id);
    return result.changes > 0;
  }

  listMergedNotArchived(): SessionInfo[] {
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE merged_at IS NOT NULL AND user_archived = 0 ORDER BY merged_at DESC",
    ).all() as SessionRow[];
    return rows.map((r) => this.fromRow(r));
  }

  listMergedNotArchivedByRemoteUrl(remoteUrl: string): SessionInfo[] {
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE merged_at IS NOT NULL AND user_archived = 0 AND remote_url = ? ORDER BY merged_at DESC",
    ).all(remoteUrl) as SessionRow[];
    return rows.map((r) => this.fromRow(r));
  }

  // This legacy name means disk-evicted, not necessarily user-hidden.
  listArchived(): SessionInfo[] {
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE disk_tier = 'evicted' ORDER BY last_used_at DESC, rowid DESC",
    ).all() as SessionRow[];
    return rows.map((r) => this.fromRow(r));
  }

  listAll(): SessionInfo[] {
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE warm = 0 ORDER BY last_used_at DESC, rowid DESC",
    ).all() as SessionRow[];
    return rows.map((r) => this.fromRow(r));
  }

  // Disk-reclaim callers need warm rows too: their containers mount live artifacts.
  listAllIncludingWarm(): SessionInfo[] {
    const rows = this.db.prepare(
      "SELECT * FROM sessions ORDER BY last_used_at DESC, rowid DESC",
    ).all() as SessionRow[];
    return rows.map((r) => this.fromRow(r));
  }

  clear(): void {
    this.db.prepare("DELETE FROM sessions").run();
  }

  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return result.changes > 0;
  }

  setWarm(id: string, warm: boolean): void {
    this.db.prepare("UPDATE sessions SET warm = ? WHERE id = ?").run(warm ? 1 : 0, id);
  }

  findAllByRemoteUrl(remoteUrl: string): SessionInfo[] {
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE remote_url = ?",
    ).all(remoteUrl) as SessionRow[];
    return rows.map((r) => this.fromRow(r));
  }

  setBranchRenamed(id: string, renamed: boolean): void {
    this.db.prepare("UPDATE sessions SET branch_renamed = ? WHERE id = ?").run(renamed ? 1 : 0, id);
  }

  setBranch(id: string, branch: string): void {
    const previous = this.db
      .prepare("SELECT branch FROM sessions WHERE id = ?")
      .get(id) as { branch: string | null } | undefined;
    this.db.prepare(
      "UPDATE sessions SET branch = ? WHERE id = ?",
    ).run(branch, id);
    if (previous !== undefined && previous.branch !== branch) this.clearPrProvenance(id);
  }

  setDiskTier(id: string, tier: "hot" | "light" | "evicted"): void {
    this.db.prepare("UPDATE sessions SET disk_tier = ? WHERE id = ?").run(tier, id);
  }

  setPinned(id: string, pinnedAt: string | null): SessionInfo | null {
    const result = this.db.prepare(
      "UPDATE sessions SET pinned_at = ? WHERE id = ?",
    ).run(pinnedAt, id);
    if (result.changes === 0) return null;
    return this.get(id) ?? null;
  }

  setMuted(id: string, mutedAt: string | null): SessionInfo | null {
    const current = this.get(id);
    if (!current) return null;
    // Muting is a flag; a repeated request must not update its timestamp.
    if (!!current.mutedAt === !!mutedAt) return null;
    this.db.prepare("UPDATE sessions SET muted_at = ? WHERE id = ?").run(mutedAt, id);
    return this.get(id) ?? null;
  }

  setKeepPreviewRunning(id: string, enabled: boolean): SessionInfo | null {
    const result = this.db.prepare(
      "UPDATE sessions SET keep_preview_running = ? WHERE id = ?",
    ).run(enabled ? 1 : 0, id);
    if (result.changes === 0) return null;
    return this.get(id) ?? null;
  }

  reorderPins(remoteUrl: string, ids: string[], now = Date.now()): SessionInfo[] {
    const apply = this.db.transaction((orderedIds: string[]) => {
      orderedIds.forEach((id, i) => {
        this.db.prepare(
          "UPDATE sessions SET pinned_at = ? WHERE id = ? AND remote_url = ? AND pinned_at IS NOT NULL",
        ).run(new Date(now - i * 1000).toISOString(), id, remoteUrl);
      });
    });
    apply(ids);
    return this.list();
  }

  // Viewer activity protects disk state without promoting a resolved session to Active.
  setLastViewedAt(id: string, iso?: string): void {
    this.db.prepare("UPDATE sessions SET last_viewed_at = ? WHERE id = ?")
      .run(iso ?? new Date().toISOString(), id);
  }

  setKind(id: string, kind: "ops" | "sandbox"): void {
    this.db.prepare("UPDATE sessions SET kind = ? WHERE id = ?").run(kind, id);
  }

  // Creation routes own this write; the agent must not grant itself capabilities.
  setCapabilities(id: string, capabilities: SessionCapabilities): void {
    this.db.prepare("UPDATE sessions SET capabilities = ? WHERE id = ?")
      .run(JSON.stringify(capabilities), id);
  }

  setModel(id: string, model: string, preferredServiceId?: string): void {
    const selection = resolveModelSelection(model, preferredServiceId);
    if (selection) {
      this.setModelSelection(id, selection);
      return;
    }
    // Unknown models cannot prove the old service, billing mode, or route still fits.
    this.db
      .prepare(
        `UPDATE sessions
         SET model = ?, service_id = NULL, billing_mode = NULL,
             provider_route_kind = NULL, provider_route_id = NULL,
             provider_route_service_id = NULL, provider_route_billing_mode = NULL
         WHERE id = ?`,
      )
      .run(model, id);
  }

  // Callers validate the catalogue selection. Keep credentials only within the same owner.
  setModelSelection(id: string, selection: ModelSelection): void {
    const current = this.get(id);
    const owner = current?.providerRouteId
      ? {
          serviceId: current.providerRouteServiceId ?? current.serviceId ?? "",
          billingMode: current.providerRouteBillingMode ?? current.billingMode ?? selection.billingMode,
          modelId: selection.modelId,
        }
      : undefined;
    const keepRoute = owner === undefined || sameCredentialOwner(owner, selection);
    if (keepRoute) {
      this.db
        .prepare("UPDATE sessions SET model = ?, service_id = ?, billing_mode = ? WHERE id = ?")
        .run(selection.modelId, selection.serviceId, selection.billingMode, id);
      return;
    }
    this.db
      .prepare(
        `UPDATE sessions
         SET model = ?, service_id = ?, billing_mode = ?,
             provider_route_kind = NULL, provider_route_id = NULL,
             provider_route_service_id = NULL, provider_route_billing_mode = NULL
         WHERE id = ?`,
      )
      .run(selection.modelId, selection.serviceId, selection.billingMode, id);
  }

  setReasoning(id: string, effort: string | null): void {
    this.db.prepare("UPDATE sessions SET reasoning_effort = ? WHERE id = ?").run(effort, id);
  }

  setAgentId(id: string, agentId: AgentId): void {
    this.db.prepare("UPDATE sessions SET agent_id = ? WHERE id = ?").run(agentId, id);
  }

  setAgentPinned(id: string): void {
    this.db.prepare("UPDATE sessions SET agent_pinned = 1 WHERE id = ?").run(id);
  }

  setLastTurnErrored(id: string, errored: boolean): void {
    this.db.prepare("UPDATE sessions SET last_turn_errored = ? WHERE id = ?").run(errored ? 1 : 0, id);
  }

  setAutoFixCiPaused(id: string, paused: boolean): void {
    this.db.prepare("UPDATE sessions SET auto_fix_ci_paused = ? WHERE id = ?").run(paused ? 1 : 0, id);
  }

  setProviderRoute(id: string, kind: ProviderRouteKind, routeId: string): void {
    const session = this.get(id);
    this.db.prepare(
      `UPDATE sessions
       SET provider_route_kind = ?, provider_route_id = ?,
           provider_route_service_id = ?, provider_route_billing_mode = ?
       WHERE id = ?`,
    ).run(
      kind,
      routeId,
      session?.serviceId ?? null,
      billingModeForRoute(kind, routeId) ?? session?.billingMode ?? null,
      id,
    );
  }

  // Callers compute rootSessionId as parent.rootSessionId ?? parent.id.
  setParentSession(id: string, parentSessionId: string, spawnedByTurn?: string, rootSessionId?: string): void {
    this.db.prepare(
      "UPDATE sessions SET parent_session_id = ?, spawned_by_turn = ?, root_session_id = ? WHERE id = ?",
    ).run(parentSessionId, spawnedByTurn ?? null, rootSessionId ?? null, id);
  }

  // Detached spawns still count against the turn's spawn cap.
  setSpawnedByTurn(id: string, spawnedByTurn: string): void {
    this.db.prepare("UPDATE sessions SET spawned_by_turn = ? WHERE id = ?").run(spawnedByTurn, id);
  }

  // Snapshot the original name; later role edits must not rewrite provenance.
  setOriginRoleName(id: string, originRoleName: string): void {
    this.db.prepare(
      "UPDATE sessions SET origin_role_name = ? WHERE id = ? AND origin_role_name IS NULL",
    ).run(originRoleName, id);
  }

  setRoleName(id: string, roleName: string | null): void {
    this.db.prepare("UPDATE sessions SET role_name = ? WHERE id = ?").run(roleName, id);
  }

  // Empty string blocks stale ?role= reconnect seeds; automatic clears use NULL.
  clearRoleName(id: string): void {
    this.db.prepare("UPDATE sessions SET role_name = '' WHERE id = ?").run(id);
  }

  roleExplicitlyCleared(id: string): boolean {
    const row = this.db
      .prepare("SELECT role_name FROM sessions WHERE id = ?")
      .get(id) as { role_name: string | null } | undefined;
    return row?.role_name === "";
  }

  countDetachedSpawnedInTurn(spawnedByTurn: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS n FROM sessions WHERE parent_session_id IS NULL AND spawned_by_turn = ? AND user_archived = 0",
    ).get(spawnedByTurn) as { n: number };
    return row.n;
  }

  findChildren(parentSessionId: string): SessionInfo[] {
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE parent_session_id = ? AND user_archived = 0 ORDER BY last_used_at DESC, rowid DESC",
    ).all(parentSessionId) as SessionRow[];
    return rows.map((r) => this.fromRow(r));
  }

  findByBranch(branch: string): SessionInfo[] {
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE branch = ? ORDER BY last_used_at DESC, rowid DESC",
    ).all(branch) as SessionRow[];
    return rows.map((r) => this.fromRow(r));
  }

  findByIdPrefix(prefix: string): SessionInfo[] {
    if (!prefix) return [];
    const escaped = prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE id LIKE ? ESCAPE '\\' ORDER BY last_used_at DESC, rowid DESC",
    ).all(`${escaped}%`) as SessionRow[];
    return rows.map((r) => this.fromRow(r));
  }

  // Only the current and immediately previous PR survive. CASE guards corrupt JSON before extraction.
  findByPrNumber(prNumber: number): SessionInfo[] {
    const rows = this.db.prepare(
      `SELECT * FROM sessions
         WHERE (CASE WHEN json_valid(pr_status)
                     THEN json_extract(pr_status, '$.prNumber') END) = ?
            OR (CASE WHEN json_valid(previous_merged_pr)
                     THEN json_extract(previous_merged_pr, '$.number') END) = ?
         ORDER BY last_used_at DESC, rowid DESC`,
    ).all(prNumber, prNumber) as SessionRow[];
    return rows.map((r) => this.fromRow(r));
  }

  getPrStatus(id: string): PrStatusSummary | null {
    const row = this.db.prepare("SELECT pr_status FROM sessions WHERE id = ?").get(id) as { pr_status: string | null } | undefined;
    if (!row?.pr_status) return null;
    try {
      return JSON.parse(row.pr_status) as PrStatusSummary;
    } catch {
      return null;
    }
  }

  setPrStatus(id: string, status: PrStatusSummary | null): void {
    const json = status === null ? null : JSON.stringify(status);
    this.db.prepare("UPDATE sessions SET pr_status = ? WHERE id = ?").run(json, id);
    if (status?.prState === "open") {
      this.db.prepare(
        "UPDATE sessions SET closed_at = NULL WHERE id = ? AND closed_at IS NOT NULL",
      ).run(id);
    }
  }

  hasAppliedMergeIssueEffect(id: string, key: string): boolean {
    const row = this.db
      .prepare("SELECT merge_issue_effects FROM sessions WHERE id = ?")
      .get(id) as { merge_issue_effects: string | null } | undefined;
    if (!row?.merge_issue_effects) return false;
    try {
      const keys = JSON.parse(row.merge_issue_effects) as string[];
      return Array.isArray(keys) && keys.includes(key);
    } catch {
      return false;
    }
  }

  // Mark only after the external effect succeeds so failures remain retryable.
  markAppliedMergeIssueEffect(id: string, key: string): void {
    const row = this.db
      .prepare("SELECT merge_issue_effects FROM sessions WHERE id = ?")
      .get(id) as { merge_issue_effects: string | null } | undefined;
    let keys: string[] = [];
    if (row?.merge_issue_effects) {
      try {
        const parsed = JSON.parse(row.merge_issue_effects) as string[];
        if (Array.isArray(parsed)) keys = parsed;
      } catch {
        // Replace corrupt JSON with a fresh array.
      }
    }
    if (keys.includes(key)) return;
    keys.push(key);
    this.db
      .prepare("UPDATE sessions SET merge_issue_effects = ? WHERE id = ?")
      .run(JSON.stringify(keys), id);
  }

  setMergeWatch(id: string, watch: SessionMergeWatch | null): void {
    const json = watch === null ? null : JSON.stringify(watch);
    this.db.prepare("UPDATE sessions SET merge_watch = ? WHERE id = ?").run(json, id);
  }

  getMergeWatch(id: string): SessionMergeWatch | undefined {
    return this.get(id)?.mergeWatch;
  }

  setSecretBlock(id: string, block: SessionSecretBlock | null): void {
    const json = block === null ? null : JSON.stringify(block);
    this.db.prepare("UPDATE sessions SET secret_block = ? WHERE id = ?").run(json, id);
  }

  getSecretBlock(id: string): SessionSecretBlock | undefined {
    return this.get(id)?.secretBlock;
  }

  // Archived children can still owe a merge notification.
  listPendingMergeWatches(): { childSessionId: string; watch: SessionMergeWatch }[] {
    const rows = this.db.prepare(
      "SELECT id, merge_watch FROM sessions WHERE merge_watch IS NOT NULL",
    ).all() as { id: string; merge_watch: string }[];
    const out: { childSessionId: string; watch: SessionMergeWatch }[] = [];
    for (const row of rows) {
      try {
        const watch = JSON.parse(row.merge_watch) as SessionMergeWatch;
        if (watch.state === "armed" || watch.state === "merge-observed") {
          out.push({ childSessionId: row.id, watch });
        }
      } catch {
        // Skip corrupt JSON.
      }
    }
    return out;
  }

  getAllPrStatuses(): PrStatusSummary[] {
    const rows = this.db.prepare(
      "SELECT pr_status FROM sessions WHERE pr_status IS NOT NULL",
    ).all() as { pr_status: string }[];
    const out: PrStatusSummary[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.pr_status) as PrStatusSummary);
      } catch {
        // Skip corrupt JSON.
      }
    }
    return out;
  }
}
