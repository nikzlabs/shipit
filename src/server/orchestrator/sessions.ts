import type { PreviousMergedPr, ProviderRouteKind, SessionCapabilities, SessionInfo, SessionMergeWatch, SessionSecretBlock, SessionTitleSource } from "../shared/types.js";
import { normalizeCapabilities } from "../shared/types.js";
import { isTerminalPrResolved, resolvedAt } from "../shared/session-resolution.js";
import type { DatabaseManager } from "../shared/database.js";
import type { PrStatusSummary } from "../shared/types/github-types.js";
import type { AgentId } from "../shared/types/agent-types.js";
import type { BillingMode, ModelSelection } from "../shared/catalogue/index.js";
import { resolveModelSelection, sameCredentialOwner } from "../shared/catalogue/index.js";
import { repoId, stripRemoteUrlCredentials } from "./git-utils.js";

/**
 * docs/252 — how a credential route is BILLED, derived from the route itself.
 *
 * The route's own mode, not the selection in force when it was pinned. Those can
 * disagree today: route selection does not yet consult the billing mode (that is
 * phase 3), so a session whose selection says `sub` can still be routed onto
 * `claude-api-key` when no subscription account is connected. Stamping the
 * *selection* there would record a metered key route as subscription-owned — a
 * durable falsehood the later phases read back.
 *
 * The rule is the same one the docs/252 migration applies to historical rows,
 * and the duplication is deliberate: a migration must keep reproducing the same
 * result forever, so it inlines its copy and cannot follow this one.
 *
 * Returns `undefined` for a route this cannot classify, leaving the caller to
 * fall back to the session's selection rather than guessing.
 */
export function billingModeForRoute(
  kind: ProviderRouteKind,
  routeId: string,
): BillingMode | undefined {
  // A login-flow account is always a subscription.
  if (kind === "account") return "sub";
  // `claude-env-oauth` is the counter-example the whole `kind` vs `via` split
  // exists for: a `reserved` route carrying a quota-bearing SUBSCRIPTION token,
  // ranked above metered billing. Classifying by `kind` would bill it as a key.
  if (routeId === "claude-env-oauth") return "sub";
  if (routeId === "claude-api-key" || routeId === "codex-api-key") return "key";
  return undefined;
}

interface SessionRow {
  id: string;
  agent_session_id: string | null;
  title: string;
  /** docs/250 — 'user' | 'agent' | NULL. Who set `title`; NULL = automatic. */
  title_source: string | null;
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
  /** docs/128 / docs/211 — server-authoritative session kind ("ops", "sandbox", or null). */
  kind: string | null;
  /** docs/211 — JSON `SessionCapabilities` for a sandbox session, or NULL. */
  capabilities: string | null;
  branch_renamed: number;
  merged_at: string | null;
  closed_at: string | null;
  model: string | null;
  /** docs/217 — per-session reasoning effort (Control B); NULL = CLI default. */
  reasoning_effort: string | null;
  agent_id: string | null;
  /** docs/138 — set once the session has taken its first turn (agent pinned). */
  agent_pinned: number;
  provider_route_kind: string | null;
  provider_route_id: string | null;
  /** docs/252 — the rest of the selection triple; `model` holds the model id. */
  service_id: string | null;
  billing_mode: string | null;
  /** docs/252 — the `(service, mode)` the pinned route was pinned FOR. */
  provider_route_service_id: string | null;
  provider_route_billing_mode: string | null;
  pr_status: string | null;
  /** docs/117 — set when the session was spawned by another via `shipit session create`. */
  parent_session_id: string | null;
  /** docs/117 — message-group id of the parent turn that spawned this session. */
  spawned_by_turn: string | null;
  /** docs/201 — top-level ancestor of the spawn tree; NULL on a top-level session. */
  root_session_id: string | null;
  /** docs/264 — the role this session was created from; NULL when none was named. Write-once. */
  origin_role_name: string | null;
  /**
   * docs/272 — the role currently IN FORCE, which the composer names. Cleared
   * when the harness, model or reasoning moves; NOT the same fact as
   * `origin_role_name` above, which records what the session STARTED as.
   */
  role_name: string | null;
  /** docs/182 — 1 when the session's last completed turn ended in an error. */
  last_turn_errored: number;
  /** docs/186 — 1 when the auto-fix-CI loop is paused for this session. */
  auto_fix_ci_paused: number;
  /** docs/110 — ISO instant the session was pinned (persistent); NULL = not pinned. */
  pinned_at: string | null;
  /** docs/241 — 1 while the session owns an always-on preview reservation. */
  keep_preview_running: number;
  /** docs/277 — ISO instant the user muted the session; NULL = not muted. */
  muted_at: string | null;
  /** docs/196 — JSON `SessionMergeWatch` for the notify-on-merge watch, or NULL. */
  merge_watch: string | null;
  /** docs/213 — JSON `SessionSecretBlock` while auto-commit is refused, or NULL. */
  secret_block: string | null;
  /** docs/194 — JSON string[] of applied merge→issue-lifecycle effect keys, or NULL. */
  merge_issue_effects: string | null;
  /** docs/202 — JSON `PreviousMergedPr` breadcrumb retained after re-arm, or NULL. */
  previous_merged_pr: string | null;
  /** docs/218 — the merged PR's head-branch tip SHA; the auto-reset safety anchor. NULL = none. */
  merged_head_sha: string | null;
  /** docs/221 — one-shot `[System] …` line the next interactive turn prepends. NULL = nothing owed. */
  pending_agent_notice: string | null;
  /**
   * docs/287 — the pull request ShipIt itself opened for this session, and the
   * repository identity it was opened in. Always read as a PAIR: a number is
   * unique only inside a repository, and `remote_url` can be repointed after
   * the fact. Both NULL for every session that predates the columns, and for
   * every pull request ShipIt merely discovered.
   */
  pr_repo_id: string | null;
  pr_number: number | null;
}

/**
 * Maximum number of recently-resolved sessions shown per repository in the
 * sidebar. docs/161 — raised from 3 to 5: the "I merged a few in a row after a
 * break and want to step back into one" moment routinely reaches past the last
 * three. The sidebar's "Recently resolved" sub-section is collapsible per repo
 * (expanded by default), so a higher cap costs nothing for users who tuck it away.
 */
export const MAX_MERGED_SESSIONS_PER_REPO = 5;

/**
 * docs/211 — parse the persisted `capabilities` JSON, tolerating corrupt/legacy
 * values (returns `undefined` so the caller falls back to the default set
 * rather than crashing a session read).
 */
function safeParseCapabilities(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/**
 * docs/161 / planning#199 — the disk-idle ladder thresholds as ONE ordered,
 * unit-consistent config (all milliseconds), replacing three free-floating
 * `*_MS` constants. "Idle age" for the ladder is
 * `now - max(Date.parse(lastUsedAt), Date.parse(lastViewedAt))` — turn activity
 * OR a recent viewer attach keeps a session warm. The disk-pressure pass can
 * escalate before these elapse when free space crosses the low-water mark
 * (LRU), so they're deliberately generous.
 *
 * The ordering `lightAfterMs ≤ evictMergedAfterMs ≤ evictUnmergedAfterMs` is a
 * coherence invariant the ladder depends on (`light` is the cheap
 * non-destructive rung, so it must come first; a merged PR is "done" so it
 * evicts sooner than unmerged WIP). It is asserted once at startup via
 * {@link assertDiskLadderOrdering} — nothing previously stopped an env override
 * from inverting it.
 */
export interface DiskLadderThresholds {
  /** `hot → light`: idle age (ms) before deps are dropped (checkout kept). */
  lightAfterMs: number;
  /** `light → evicted`: idle age (ms) for MERGED sessions ("done" → reclaim fast). */
  evictMergedAfterMs: number;
  /** `light → evicted`: idle age (ms) for UNMERGED WIP (the gentle clock). */
  evictUnmergedAfterMs: number;
}

/**
 * docs/161 / planning#199 — the default ladder.
 *   - 24h `hot → light`: non-destructive (deps reinstall in seconds) → act early.
 *   - 2d  merged `light → evicted`: a merge is a strong "done" signal and the
 *     checkout re-fetches fresh on reopen → reclaim finished work soon.
 *   - 14d unmerged `light → evicted`: WIP the user may return to → be gentle.
 */
export const DEFAULT_DISK_LADDER: DiskLadderThresholds = {
  lightAfterMs: 24 * 60 * 60 * 1000, // 24h
  evictMergedAfterMs: 2 * 24 * 60 * 60 * 1000, // 2d
  evictUnmergedAfterMs: 14 * 24 * 60 * 60 * 1000, // 14d
};

/**
 * planning#199 — fail-fast guard on the ladder ordering. The ladder is incoherent
 * unless `lightAfterMs ≤ evictMergedAfterMs ≤ evictUnmergedAfterMs`; an env
 * override that inverts it (e.g. `DISK_IDLE_EVICT_MERGED_MS < DISK_IDLE_LIGHT_MS`)
 * would make a session jump straight to `evicted` before ever reaching `light`,
 * or evict unmerged WIP sooner than merged work. Throw at startup rather than
 * silently misbehave at runtime.
 */
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
 * Parent/child exemption (docs/117, generalized to whole spawn trees in
 * docs/201): the merged view cap is a form of *automatic* archiving, and spawned
 * clusters are exempt from it — they only leave the sidebar via an explicit user
 * archive (which `archiveSession` cascades from a session through its whole
 * brood — except from an Ops session, which never cascades; docs/162). The
 * exemption keys off the ROOT ancestor (`rootSessionId`) rather than
 * the immediate parent so it is depth-independent. Concretely, the cap never
 * demotes:
 *   - a root that still has a live (non-user-archived) descendant — a root with
 *     a brood is only ever archived manually, and
 *   - any descendant whose root is still live — a child or grandchild is only
 *     archived together with its root, never on its own.
 * Keying off the root (not the parent) is what keeps a grandchild visible after
 * its intermediate parent merges. Both exemptions only rescue a session the cap
 * would otherwise drop; user-archived sessions are still excluded, so the manual
 * cascade is unaffected.
 */
/**
 * docs/241 — does this session hold a live always-on preview reservation?
 *
 * The flag alone is not the answer, and every consumer needs the same one. An
 * archived row can still carry it (rows archived before `archive()` learned to
 * clear it), and such a row must not consume the deployment's capped slot, must
 * not exempt a surviving container from idle eviction or disk reclaim, and must
 * not paint an "always-on" marker on a session whose workspace is gone. Reading
 * the raw flag in one place and this predicate in another is what lets the two
 * disagree: admission ignoring a stale row while the idle enforcer protects its
 * container is how a deployment ends up holding two reservations' worth of RAM
 * with one slot on the books.
 */
export function holdsActiveReservation(session: SessionInfo | undefined | null): boolean {
  return !!session?.keepPreviewRunning && !session.userArchived && !session.archived && !session.warm;
}

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
  // docs/201 — parent/child exemption keyed off the ROOT ancestor, not the
  // immediate parent, so it is depth-independent: a grandchild stays exempt
  // while its top-level root is live, even after the intermediate child merges
  // (the old `parentSessionId`-only check dropped grandchildren from the sidebar
  // in exactly that case). `rootSessionId` is NULL on a top-level session, so
  // only spawned descendants contribute a root — a lone top-level session never
  // self-exempts (the reason we keep the field undefined on roots rather than
  // self-referencing; a self-ref would put every live session in `liveRoots` and
  // silently void the merged-view cap). User-archived sessions don't count — an
  // archived root shouldn't pin its brood open (archiving cascades root→brood).
  const liveIds = new Set<string>();
  const liveRoots = new Set<string>();
  for (const s of sessions) {
    if (s.userArchived) continue;
    liveIds.add(s.id);
    if (s.rootSessionId) liveRoots.add(s.rootSessionId);
  }
  const exemptFromCap = (s: SessionInfo): boolean =>
    liveRoots.has(s.id) || // a root with a live descendant
    (s.rootSessionId !== undefined && liveIds.has(s.rootSessionId)); // a descendant of a live root
  return sessions.filter(
    (s) =>
      !s.userArchived &&
      // docs/110 — a pinned (persistent) session is always visible: like the
      // parent/child exemption, a pin overrides the merged top-N view cap so a
      // pinned session never silently drops out of the sidebar.
      //
      // docs/241 — an always-on reservation earns the same exemption, and for a
      // stronger reason than a pin: it consumes the deployment's capped runtime
      // slot, and the sidebar row is where the user is told which session holds
      // it. A reserved session demoted by the merged cap would keep the slot
      // while vanishing from the surface that explains where the slot went.
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
      // Back-compat: `archived` now means "user explicitly hid it".
      info.archived = true;
    }
    if (row.last_viewed_at) info.lastViewedAt = row.last_viewed_at;
    if (row.warm) info.warm = true;
    if (row.branch) info.branch = row.branch;
    if (row.kind === "ops") info.kind = "ops";
    if (row.kind === "sandbox") {
      info.kind = "sandbox";
      // docs/211 — a sandbox always reports a fully-populated capability set;
      // `normalizeCapabilities` backfills the defaults for a NULL/partial/corrupt
      // value so consumers never branch on `undefined`.
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
    // docs/252 — the rest of the selection triple. Read independently of
    // `model`: a row can legitimately carry a service and mode with no model yet
    // (the selection was resolved before a pick), and a model with no service
    // (a versioned id the catalogue has no row for).
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
        // Corrupt/legacy JSON — treat as no watch rather than crashing reads.
      }
    }
    if (row.previous_merged_pr) {
      try {
        info.previousMergedPr = JSON.parse(row.previous_merged_pr) as SessionInfo["previousMergedPr"];
      } catch {
        // Corrupt/legacy JSON — drop the breadcrumb rather than crashing reads.
      }
    }
    if (row.secret_block) {
      try {
        info.secretBlock = JSON.parse(row.secret_block) as SessionInfo["secretBlock"];
      } catch {
        // Corrupt/legacy JSON — treat as unblocked rather than crashing reads.
        // Safe to lose: the next auto-commit re-scans and re-arms the block.
      }
    }
    if (row.merged_head_sha) info.mergedHeadSha = row.merged_head_sha;
    if (row.pending_agent_notice) info.pendingAgentNotice = row.pending_agent_notice;
    // docs/287 — surfaced only as a PAIR. Half a provenance record cannot
    // authorise anything: a number with no repository names a pull request in
    // whatever repository the session happens to point at now, and a repository
    // with no number names none. A row carrying one and not the other is a bug
    // upstream, and reading it as absent is the answer that refuses the merge.
    if (row.pr_number && row.pr_repo_id) {
      info.prNumber = row.pr_number;
      info.prRepoId = row.pr_repo_id;
    }
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

  /**
   * docs/221 — record the one-shot `[System] …` line the session's next
   * interactive turn must prepend, after something moved the branch outside any
   * turn (the manual "Sync with `<base>`" rebase / merged-branch reset).
   *
   * Last-write-wins by design: every writer is describing the same fact (where
   * this branch now points), so a second sync before the user's next message
   * supersedes the first rather than queueing behind it.
   *
   * planning#426 — that rationale is why {@link appendPendingAgentNotice} exists
   * beside it rather than replacing it. This slot now carries a SECOND fact class
   * (a fork's LFS content is unresolved), and for two writers describing
   * *different* facts, last-write-wins is data loss rather than supersession.
   * Branch-movement notices keep this setter and keep superseding each other.
   */
  setPendingAgentNotice(id: string, notice: string): void {
    this.db.prepare("UPDATE sessions SET pending_agent_notice = ? WHERE id = ?").run(notice, id);
  }

  /**
   * planning#426 — add a notice describing a DIFFERENT fact from whatever may
   * already be pending, instead of overwriting it.
   *
   * Read-modify-write in one transaction, so two concurrent appends cannot read
   * the same prior value and each write a version missing the other's line.
   * Idempotent on exact repeats: re-running a fork-time report must not stack the
   * same paragraph twice.
   *
   * Note the asymmetry this deliberately does NOT fix, because one slot cannot:
   * a *later* `setPendingAgentNotice` (a manual sync of this branch before its
   * first turn) still replaces an appended notice wholesale. Widening the slot
   * into a queue is not worth it for that window — the user-facing toast has
   * already fired, and docs/221's own contract already accepts losing one notice.
   * Recorded as a known gap in `docs/231-git-lfs-support/plan.md`.
   */
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

  /**
   * docs/221 — consume (read + clear) the pending agent notice. Transactional so
   * the notice is delivered exactly once: a turn that reads it owns it, and a
   * crash before the prompt reaches the agent loses one notice rather than
   * repeating it on every subsequent turn.
   */
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

  /** Clear the agent session ID for a session. */
  clearAgentSessionId(id: string): void {
    this.db.prepare("UPDATE sessions SET agent_session_id = NULL WHERE id = ?").run(id);
  }

  /**
   * Cache the origin remote URL for a session.
   *
   * Stored credential-free (docs/262 req 19): this column is what
   * `cloneFromCache` and the fork path write into a session clone's
   * `remote.origin.url`, i.e. into `/project/.git/config` — a file the agent
   * and every plugin CLI and plugin service can read. The row is also written
   * from an existing workspace's own origin (`services/session.ts`), so a
   * checkout left credentialed by an older build cannot feed one back in here.
   *
   * Only http(s) userinfo is removed — see `stripUrlCredentials`. Other shapes
   * a user can type (`ssh://git:pw@…`, `?access_token=`) are still handled at
   * the cross-session display boundary by `sanitizeRemoteUrlForInventory`.
   */
  setRemoteUrl(id: string, remoteUrl: string | undefined): void {
    const stored = remoteUrl === undefined ? null : stripRemoteUrlCredentials(remoteUrl);
    const previous = this.db
      .prepare("SELECT remote_url FROM sessions WHERE id = ?")
      .get(id) as { remote_url: string | null } | undefined;
    this.db.prepare("UPDATE sessions SET remote_url = ? WHERE id = ?").run(stored, id);
    // docs/287 — repointing `origin` invalidates the merge provenance. The
    // recorded pull request lives in the OLD repository, so leaving it would let
    // a number from repository A authorise a merge that now resolves against
    // repository B. Cleared here rather than at the callers because this is the
    // single place the column moves, and comparing identities (not strings)
    // keeps a no-op rewrite — the same remote in another spelling — from
    // discarding a valid record.
    if (previous !== undefined && repoId(previous.remote_url ?? "") !== repoId(stored ?? "")) {
      this.clearPrProvenance(id);
    }
  }

  /**
   * docs/287 — record the pull request ShipIt just WITNESSED itself opening.
   *
   * Written as a pair, and only from a create whose outcome said it created
   * something. Every discovery path — the poller finding a pull request by
   * branch name, a create that returned one already open — deliberately calls
   * nothing here: a discovered pull request may be a person's, and adopting it
   * would grant the agent merge rights over their work (req 5).
   *
   * `repoIdentity` is the repository the create actually landed in, not the one
   * the caller asked for. Callers resolve it from the create's own answer.
   */
  recordPrProvenance(id: string, prNumber: number, repoIdentity: string): void {
    if (!Number.isInteger(prNumber) || prNumber <= 0 || !repoIdentity) return;
    this.db
      .prepare("UPDATE sessions SET pr_number = ?, pr_repo_id = ? WHERE id = ?")
      .run(prNumber, repoIdentity, id);
  }

  /**
   * docs/287 — forget the recorded pull request, as a pair.
   *
   * Called wherever the session's relationship to its pull request ends: the
   * docs/202 re-arm, an explicit PR reset, unarchive deciding the old pull
   * request no longer applies, and a change of `origin`. Clearing is always
   * safe — the worst outcome is that the agent is told to merge from the card —
   * while a stale record is an authorisation over the wrong pull request.
   */
  clearPrProvenance(id: string): void {
    this.db
      .prepare("UPDATE sessions SET pr_number = NULL, pr_repo_id = NULL WHERE id = ?")
      .run(id);
  }

  /**
   * Rename a session. Returns the updated session, or null if not found.
   *
   * docs/250 — `source` records WHO set the title so the two automatic writers
   * can tell whether they may overwrite it later. Omit it for an automatic or
   * born-with title (graduation placeholder, AI namer, `explicitTitle`); those
   * write NULL and stay replaceable. Pass `"user"` for a hand rename (final) or
   * `"agent"` for `shipit session rename` (the AI namer must not clobber it).
   *
   * The write is unconditional by design — precedence is the caller's decision,
   * expressed once in {@link isTitleLockedAgainst} (`services/session-title.ts`),
   * because the two gated writers need to *skip their whole flow*, not just this
   * one statement (the AI namer must not rename the branch either).
   */
  rename(id: string, title: string, source?: SessionTitleSource): SessionInfo | null {
    const result = this.db
      .prepare("UPDATE sessions SET title = ?, title_source = ? WHERE id = ?")
      .run(title, source ?? null, id);
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
    // docs/110 — clear any pin on archive: a session can't be both hidden and
    // persistent. This also keeps the disk-janitor's pinned guards sound, since
    // an archived (evicted) session is never simultaneously pinned.
    //
    // docs/241 — and release the always-on preview reservation for the same
    // reason, but with sharper consequences: reservations are capped (default 1
    // per deployment) and the toggle that releases one is only rendered on a
    // NON-archived row (`SessionItem.tsx`). A flag surviving archive therefore
    // consumed the deployment's only slot from a session the user could no
    // longer see or toggle, and "Always-on preview capacity is full (1/1)" had
    // no reachable cause. Archiving evicts the workspace anyway, so there is
    // nothing left to keep previewing.
    const result = this.db.prepare(
      "UPDATE sessions SET user_archived = 1, disk_tier = 'evicted', pinned_at = NULL, keep_preview_running = 0 WHERE id = ?",
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
    // docs/241 — restore never restores a reservation. For a row archived after
    // `archive()` learned to clear the flag this is a no-op; for a legacy row
    // that still carries it, clearing here is what stops the restore from
    // silently creating a SECOND active reservation. Admission ignores the row
    // while it is archived, so another session may have taken the slot in the
    // meantime, and unarchive runs no admission check of its own. The user
    // re-enables it from the menu if they still want it.
    this.db.prepare(
      "UPDATE sessions SET user_archived = 0, disk_tier = 'hot', keep_preview_running = 0 WHERE id = ?",
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
   * docs/218 — record the merged PR's head-branch tip SHA. Captured by the PR
   * poller when it promotes the session to merged (from the PR's `head.sha`),
   * before the merge side effects fire. This is the safety anchor for the
   * auto-reset-merged-branch-on-continue feature: a later pre-turn
   * `reset --hard origin/<base>` only fires when the local HEAD still equals
   * this SHA, proving the branch carries no post-merge work that the reset would
   * discard. Stored unconditionally (idempotent re-writes of the same value are
   * harmless); the feature fails closed when it is NULL.
   */
  setMergedHeadSha(id: string, sha: string): void {
    this.db.prepare("UPDATE sessions SET merged_head_sha = ? WHERE id = ?").run(sha, id);
  }

  /**
   * docs/202 — un-merge a session that was re-armed after a rebase. Clears
   * `merged_at` (mirroring how {@link setPrStatus} clears `closed_at` on reopen)
   * and stashes a display-only `PreviousMergedPr` breadcrumb of the prior PR.
   *
   * Clearing `merged_at` is the whole mechanism: it pulls the session back into
   * Active (`resolvedAt()` → null), removes it from the sidebar's "Recently
   * resolved" Done group, gives it the gray fresh-session indicator, and reverts
   * it from the fast merged disk-eviction ladder to the normal one — no separate
   * pin or flag needed. The breadcrumb is deliberately display-only (plus the
   * poller's superseded-PR suppression key + new-PR base target); it must NOT
   * feed `resolvedAt()`, grouping, status color, or the eviction tier.
   *
   * Returns true when a row was un-merged (was merged before this call).
   */
  clearMerged(id: string, previousMergedPr: PreviousMergedPr | null): boolean {
    const json = previousMergedPr === null ? null : JSON.stringify(previousMergedPr);
    // docs/218 — also drop the merged-tip anchor: once un-merged there is no
    // merged tip, and a stale value must never let the auto-reset feature fire
    // against a session that is no longer in the merged state.
    // docs/287 — and the merge provenance, in the same statement. The re-arm
    // means this session's relationship to that pull request has ended: the
    // recorded number now names a MERGED pull request, and leaving it would let
    // the agent ask ShipIt to merge one that already shipped. A new pull request
    // records a new number when ShipIt opens it.
    const result = this.db.prepare(
      "UPDATE sessions SET merged_at = NULL, previous_merged_pr = ?, merged_head_sha = NULL, "
      + "pr_number = NULL, pr_repo_id = NULL WHERE id = ? AND merged_at IS NOT NULL",
    ).run(json, id);
    return result.changes > 0;
  }

  /**
   * Drop every record of a prior pull request, for a session whose branch has
   * been replaced by a brand-new one cut off the default branch (unarchive —
   * `unarchiveSession`). Unconditional, and deliberately NOT {@link clearMerged}:
   *
   *  - `clearMerged` only fires `WHERE merged_at IS NOT NULL`, so it leaves the
   *    breadcrumb standing on a session that was re-armed *before* it was
   *    archived — which feeds `computeResetBlocker`'s `previousMergedPr`
   *    fallback and makes the fresh branch look like it shipped work.
   *  - `clearMerged` WRITES a `previousMergedPr` breadcrumb. Here the correct
   *    breadcrumb is none at all: the breadcrumb exists to name a reset target
   *    for a branch that still carries the merged PR's work, and this branch
   *    carries none of it. Retaining the old PR's base would point the docs/218
   *    gate at a target with no relationship to the new branch.
   *
   * Paired with `PrStatusPoller.clearPersisted` (which nulls `pr_status`) inside
   * `unarchiveSession`: the two express ONE decision — "the old pull request no
   * longer applies to this session" — and splitting them across two call sites
   * is how the merged half came to be forgotten, leaving `merged_at` alive next
   * to a nulled snapshot. That state made the pre-turn auto-reset (docs/218)
   * refuse every turn with `no-base-branch`, and then propagated: the next PR's
   * snapshot coexisted with the stale merge record, so the refusal notice
   * claimed an OPEN pull request had merged.
   */
  clearPriorPrRecord(id: string): void {
    this.db.prepare(
      "UPDATE sessions SET merged_at = NULL, merged_head_sha = NULL, previous_merged_pr = NULL, "
      + "pr_number = NULL, pr_repo_id = NULL WHERE id = ?",
    ).run(id);
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

  /**
   * docs/255 — literally every session row, warm pool included, most recently
   * used first. Most "all sessions" callers mean {@link listAll}'s non-warm set,
   * because a warm row is a pre-provisioned shell rather than someone's work.
   *
   * Two kinds of caller need this one instead: the Ops inventory's
   * `--include-warm`, and **disk-reclaim liveness** (planning#439) — a warm
   * session runs a container that mounts overlay bases and plugin artifacts
   * exactly like any other, so excluding it from a live-set means deleting a
   * live mount's backing directory. "Whose work is this" and "what is on disk
   * right now" are different questions; only the first one skips warm rows.
   */
  listAllIncludingWarm(): SessionInfo[] {
    const rows = this.db.prepare(
      "SELECT * FROM sessions ORDER BY last_used_at DESC, rowid DESC",
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
   * docs/110 — pin or unpin a session. Pass an ISO timestamp to pin (the value
   * orders pins within a repo group, most-recent first) or null to unpin.
   * Forward-looking: this only records the pin — the session's current disk tier
   * is left untouched (flipping it to `hot` here would lie about the on-disk
   * checkout). From this point `canAutoDescend` keeps a pinned session from being
   * reclaimed; selecting an already-reclaimed session still restores it the
   * normal way. Returns the updated session, or null if not found.
   */
  setPinned(id: string, pinnedAt: string | null): SessionInfo | null {
    const result = this.db.prepare(
      "UPDATE sessions SET pinned_at = ? WHERE id = ?",
    ).run(pinnedAt, id);
    if (result.changes === 0) return null;
    return this.get(id) ?? null;
  }

  /**
   * docs/277 — mute or unmute a session. Pass an ISO instant to mute, or null to
   * unmute. Records nothing but the flag: a mute suppresses the session's
   * attention signals (req 2) and changes no other property of the session
   * (req 3), so pin, disk tier and the idle clocks are all left alone.
   *
   * Returns the updated session, or null if not found. Also returns null when
   * nothing changed — the caller uses that to skip the SSE broadcast on the
   * overwhelmingly common case: an ordinary turn on an unmuted session.
   */
  setMuted(id: string, mutedAt: string | null): SessionInfo | null {
    const current = this.get(id);
    if (!current) return null;
    // Compare on PRESENCE, not on the value. Muting is a flag whose timestamp is
    // incidental, so a second mute of an already-muted session must be a no-op:
    // gating the UPDATE on the value instead (`muted_at IS NOT ?`) rewrote the
    // instant every time, which reported a change that nothing had asked for and
    // made the no-op path depend on two calls landing in the same millisecond.
    if (!!current.mutedAt === !!mutedAt) return null;
    this.db.prepare("UPDATE sessions SET muted_at = ? WHERE id = ?").run(mutedAt, id);
    return this.get(id) ?? null;
  }

  /** Persist the docs/241 runtime reservation without changing pin or idle clocks. */
  setKeepPreviewRunning(id: string, enabled: boolean): SessionInfo | null {
    const result = this.db.prepare(
      "UPDATE sessions SET keep_preview_running = ? WHERE id = ?",
    ).run(enabled ? 1 : 0, id);
    if (result.changes === 0) return null;
    return this.get(id) ?? null;
  }

  /**
   * docs/110 Phase 2 — reorder a repo's pinned sessions to match `ids`. Pins
   * sort by `pinned_at` descending, so we rewrite `pinned_at` to a strictly
   * decreasing sequence anchored at `now`: `ids[0]` gets the largest stamp and
   * lands on top. Spaced 1s apart so the order is unambiguous and a subsequently
   * pinned session (stamped at a later `now`) still floats above the set.
   * Defensive: only rows that are currently pinned AND belong to `remoteUrl` are
   * touched, so a stale or cross-repo id from the client is ignored. All updates
   * run in one transaction. Returns the refreshed sidebar list.
   */
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
   * docs/128 / docs/211 — set the server-authoritative session kind. `"ops"`
   * gates the privileged journal mounts + read-only Docker proxy; `"sandbox"`
   * (docs/211) marks a repo-less, capability-scoped session. Set once at creation
   * by the gated creation route; the container cannot flip it.
   */
  setKind(id: string, kind: "ops" | "sandbox"): void {
    this.db.prepare("UPDATE sessions SET kind = ? WHERE id = ?").run(kind, id);
  }

  /**
   * docs/211 — persist the immutable capability set for a sandbox session. Set
   * once at creation (alongside `setKind(id, "sandbox")`), never from inside the
   * container, so an agent cannot self-grant `git`/`docker`/`network`. Stored as
   * JSON; `fromRow` reads it back through `normalizeCapabilities`.
   */
  setCapabilities(id: string, capabilities: SessionCapabilities): void {
    this.db.prepare("UPDATE sessions SET capabilities = ? WHERE id = ?")
      .run(JSON.stringify(capabilities), id);
  }

  /**
   * Store the selected model for a session.
   *
   * docs/252 — the selection is the triple `(serviceId, billingMode, modelId)`,
   * so this resolves the bare id through the catalogue and writes all three.
   * Callers that already know the service and mode should use
   * {@link setModelSelection} directly; this overload stays because most call
   * sites (the WS picker, graduation, the authed-selection redirect) still speak
   * model ids and will keep doing so until the picker groups by service in
   * phase 3.
   *
   * `preferredServiceId` biases resolution so a model id the harness's own
   * vendor offers stays on that vendor rather than landing on whichever gateway
   * happens to list the same string.
   */
  setModel(id: string, model: string, preferredServiceId?: string): void {
    const selection = resolveModelSelection(model, preferredServiceId);
    if (selection) {
      this.setModelSelection(id, selection);
      return;
    }
    // The catalogue has no row for this id — a versioned slug the picker never
    // surfaced, or one since retired. **Clear the service and mode rather than
    // leaving the previous ones in place**: the invariant a stored row must hold
    // is that its triple either names a real catalogue row or carries no service
    // and mode at all. Keeping the old pair would leave
    // `(anthropic, sub, claude-sonnet-4-20250514)` on disk — a triple
    // `resolveEndpoint` cannot shape a turn from and `selectionExists` reports
    // false for, which is worse than saying nothing.
    //
    // The pinned route goes with them, for the same reason `setModelSelection`
    // drops it on an owner change: with no service we cannot prove the route
    // still fits, and re-pinning on the next turn is cheap where mis-billing is
    // not.
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

  /**
   * docs/252 — persist a full `(serviceId, billingMode, modelId)` selection.
   *
   * **This is where the pinned credential route is invalidated**, and that is
   * the whole reason the write goes through one method. A route belongs to a
   * `(service, billing mode)` and environment preparation reuses it
   * unconditionally whenever it is present, so a selection that crosses either
   * axis must drop it — otherwise the next turn respawns against the new
   * endpoint and authenticates with the previous service's credential, billing
   * the wrong account. A plain model change *within* one mode keeps the route,
   * which is what makes mid-session model switching free.
   *
   * Inert today: both first-party services are the only ones reachable and a
   * session cannot yet cross services. It is here rather than in phase 3
   * because phase 3 is what makes the crossing *reachable*, and a route that
   * outlives its owner is not a failed turn — it is a silently mis-billed one.
   *
   * **Contract: `selection` must name a real catalogue row.** This method writes
   * what it is given, because the alternative — silently dropping a write, or
   * throwing on a path that today swallows errors — is worse than a caller
   * checking. Every caller does: `setModel` only reaches here via
   * `resolveModelSelection`, and the three that build a triple from untrusted
   * input (the WS `set_model` message, the session-creation route, the browser
   * seed) each gate on `selectionExists` first. The invariant a stored row holds
   * is that its triple resolves or its service and mode are absent.
   */
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

  /**
   * docs/217 — store the per-session reasoning effort (Control B). `null` clears
   * it (back to the CLI default).
   */
  setReasoning(id: string, effort: string | null): void {
    this.db.prepare("UPDATE sessions SET reasoning_effort = ? WHERE id = ?").run(effort, id);
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

  /**
   * docs/182 — record whether the session's last completed turn errored. Set on
   * every turn completion (true on agent error / errored agent_result, false on
   * a clean finish) so `shipit session wait` can resolve a distinct `error`
   * outcome that survives an orchestrator restart (the runner's in-memory flag
   * does not). Persisted on the session row; read by the child-session readiness
   * check alongside the runner's live flag.
   */
  setLastTurnErrored(id: string, errored: boolean): void {
    this.db.prepare("UPDATE sessions SET last_turn_errored = ? WHERE id = ?").run(errored ? 1 : 0, id);
  }

  /**
   * docs/186 — pause or resume the auto-fix-CI loop for a single session. A
   * per-session override on top of the global `autoFixCi` setting: while paused,
   * the PR poller's auto-fix loop is suppressed for this session even with the
   * global setting on. Persisted so the pause survives an orchestrator restart.
   */
  setAutoFixCiPaused(id: string, paused: boolean): void {
    this.db.prepare("UPDATE sessions SET auto_fix_ci_paused = ? WHERE id = ?").run(paused ? 1 : 0, id);
  }

  /**
   * Pin the credential route a turn resolved.
   *
   * docs/252 — the route is stamped with the `(service, billing mode)` it was
   * pinned FOR, taken from the session's current selection. That owner is what
   * {@link setModelSelection} compares against to decide whether a later
   * selection change invalidates the route.
   */
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

  /**
   * docs/117 — record that this session was spawned by another session.
   * `spawnedByTurn` is optional context for "list children spawned in the
   * current turn" sorting; pass `undefined` if the caller doesn't have a
   * turn id handy.
   *
   * docs/201 — `rootSessionId` is the top-level ancestor of the spawn tree,
   * computed by the caller as `parent.rootSessionId ?? parent.id` so it never
   * walks the chain at read time. Pass `undefined` for a direct-from-top spawn
   * only if the caller has no root to record; the sidebar grouping degrades to
   * one level for that row until it is re-stamped.
   */
  setParentSession(id: string, parentSessionId: string, spawnedByTurn?: string, rootSessionId?: string): void {
    this.db.prepare(
      "UPDATE sessions SET parent_session_id = ?, spawned_by_turn = ?, root_session_id = ? WHERE id = ?",
    ).run(parentSessionId, spawnedByTurn ?? null, rootSessionId ?? null, id);
  }

  /**
   * docs/205 — record the spawning turn WITHOUT a parent linkage, for a
   * `--detached` spawn. A detached session is deliberately parentless (so it
   * neither nests in the sidebar nor is reachable by the coordination shim —
   * see {@link findChildren} / `assertChildOfParent`), but it still carries its
   * originating turn id so {@link countDetachedSpawnedInTurn} can enforce the
   * per-turn spawn cap against it. This is the one field `setParentSession`
   * would normally write that a detached spawn still needs; the parent/root
   * columns stay NULL.
   */
  setSpawnedByTurn(id: string, spawnedByTurn: string): void {
    this.db.prepare("UPDATE sessions SET spawned_by_turn = ? WHERE id = ?").run(spawnedByTurn, id);
  }

  /**
   * docs/264-agent-roles req 14 — record WHICH role started this session. Write-once.
   *
   * **The `IS NULL` clause is the immutability**, not a comment about it: a
   * second call cannot change what a first one recorded, so the field means "the
   * role this session was created from" for as long as the row exists. Provenance
   * that could be rewritten would answer a different question every time it was
   * asked, and this one is read long after the fact — by a user asking what a
   * child in their sidebar came from.
   *
   * It is deliberately a **snapshot of the name** and not a reference: renaming
   * or deleting the role does not reach in here, and the child may over time run
   * on something other than what the role named (req 11).
   */
  setOriginRoleName(id: string, originRoleName: string): void {
    this.db.prepare(
      "UPDATE sessions SET origin_role_name = ? WHERE id = ? AND origin_role_name IS NULL",
    ).run(originRoleName, id);
  }

  /**
   * docs/272-user-selectable-roles reqs 13, 15 — the role currently **in force**, which is what
   * the composer names.
   *
   * The deliberate opposite of {@link SessionManager.setOriginRoleName} above,
   * and the pair is the whole of docs/272's storage: that one is write-once
   * provenance ("what did this session start as"), this one is mutable truth
   * ("does the role still describe what it runs on"). Set when the user selects
   * a role; cleared with `null` the moment the harness, model or reasoning
   * moves, because changing one of them is the whole of leaving a role (req 15).
   *
   * Nothing derives it. A session whose parameters happen to equal a role's is
   * NOT named after that role (req 13): a role also carries standing
   * instructions, which no amount of moving three controls puts in force, so the
   * name reports the user's choice and only that.
   */
  setRoleName(id: string, roleName: string | null): void {
    this.db.prepare("UPDATE sessions SET role_name = ? WHERE id = ?").run(roleName, id);
  }

  /**
   * docs/272-user-selectable-roles req 18 — the user chose **"No role"**, which is
   * not the same fact as never having chosen one.
   *
   * Both are "no role in force", and every reader of {@link SessionInfo.roleName}
   * sees exactly that: the row holds `''`, and `fromRow`'s truthiness test drops
   * it, so nothing downstream gains a third case to handle. The one place the
   * difference matters is the `?role=` connect seed, which asks
   * {@link SessionManager.roleExplicitlyCleared}.
   *
   * **Why the distinction has to be stored at all.** The browser's seed slot
   * (req 12) is baked into the session WebSocket's URL, and that URL is memoized
   * per session — so a socket that reconnects after the clear still carries the
   * cleared role's name. The connect handler would then apply it to a session
   * with no role in force, and the user's clear would silently undo itself
   * somewhere between the clear and the first message. The handler's own note
   * used to say no such guard was needed, and it was right at the time: the only
   * clears that existed were the automatic ones, which happen precisely because
   * the role became unrunnable, so re-applying it refuses harmlessly. An
   * explicitly cleared role is perfectly runnable, and that is what breaks the
   * old argument.
   *
   * The automatic clears keep writing `null` (see {@link SessionManager.setRoleName}):
   * "the role stopped being true" is not the user saying "none", and only the
   * second should outrank a seed.
   */
  clearRoleName(id: string): void {
    this.db.prepare("UPDATE sessions SET role_name = '' WHERE id = ?").run(id);
  }

  /** Did the user choose "No role" on this session? See {@link SessionManager.clearRoleName}. */
  roleExplicitlyCleared(id: string): boolean {
    const row = this.db
      .prepare("SELECT role_name FROM sessions WHERE id = ?")
      .get(id) as { role_name: string | null } | undefined;
    return row?.role_name === "";
  }

  /**
   * docs/205 — count detached (parentless) sessions spawned in a given turn.
   * Mirrors `findChildren`'s `user_archived = 0` filter so the per-turn cap
   * counts the same liveness class for detached spawns as it does for linked
   * children. Detached sessions have no `parent_session_id`, so they never show
   * up in `findChildren` — this is how the per-turn fan-out cap still bounds
   * them. Scoped only by turn id (a turn belongs to one parent session), so the
   * count never under-reports; a same-turn-string collision across two parents
   * would only over-count, which is the safe (fail-closed) direction for a
   * runaway guard.
   */
  countDetachedSpawnedInTurn(spawnedByTurn: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS n FROM sessions WHERE parent_session_id IS NULL AND spawned_by_turn = ? AND user_archived = 0",
    ).get(spawnedByTurn) as { n: number };
    return row.n;
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
   * docs/255 — every session (warm/archived included) on the given branch.
   *
   * Ops-inventory lookup: a branch name is what an operator has in hand from a
   * PR's head ref. Unfiltered by liveness on purpose — the service layer decides
   * what to hide, so a triage question about a finished session still resolves.
   */
  findByBranch(branch: string): SessionInfo[] {
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE branch = ? ORDER BY last_used_at DESC, rowid DESC",
    ).all(branch) as SessionRow[];
    return rows.map((r) => this.fromRow(r));
  }

  /**
   * docs/255 — every session whose id starts with `prefix`.
   *
   * Backs both the `--id` filter (a truncated UUID pasted from a log line) and
   * the `--container` filter, since both host-visible container-name shapes
   * (`agent-<slice>`, `shipit-<slice>-<service>-N`) embed `id.slice(0, 12)`.
   *
   * `%`, `_` and `\` in the prefix are escaped: a name lifted verbatim from
   * `docker volume ls` (`shipit-<slice>_node_modules`) contains `_`, which LIKE
   * would otherwise read as a single-character wildcard.
   */
  findByIdPrefix(prefix: string): SessionInfo[] {
    if (!prefix) return [];
    const escaped = prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE id LIKE ? ESCAPE '\\' ORDER BY last_used_at DESC, rowid DESC",
    ).all(`${escaped}%`) as SessionRow[];
    return rows.map((r) => this.fromRow(r));
  }

  /**
   * docs/255 — every session whose persisted PR snapshot names `prNumber`.
   *
   * Matches the CURRENT snapshot (`pr_status.prNumber`) and the retained
   * breadcrumb of the previously-merged PR (`previous_merged_pr.number`,
   * docs/202) — which is exactly the case that dead-ended the 2026-08-06
   * investigation (`shipit/kmwodw` carried #1741 and then #1744).
   *
   * LIMIT, by the data model: `clearMerged` OVERWRITES the single breadcrumb on
   * each re-arm, so only the *immediately* preceding PR is retained. A branch
   * that shipped #1, #2, #3 resolves from #3 and #2 but not #1. Retaining the
   * full history would mean widening docs/202's breadcrumb into a list, which
   * belongs to that feature rather than to this read-only lookup.
   *
   * `json_extract` keeps this a single scan rather than loading and parsing
   * every row; SQLite's JSON1 extension is compiled into the bundled
   * better-sqlite3 build. The `json_valid` CASE wrappers are load-bearing:
   * `json_extract` raises "malformed JSON" on a corrupt column value, which
   * would fail the WHOLE query — and every other reader of these two columns
   * already tolerates corrupt JSON by returning null (`getPrStatus`, `fromRow`).
   * A bare `json_valid(x) AND json_extract(x, …)` is not enough, because the
   * planner is free to reorder AND operands; the CASE forces the guard first.
   */
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

  /**
   * Persist the PR status snapshot for a session. Stored as JSON so archived
   * sessions can keep their PR badge / number / URL across server restarts.
   * Pass `null` to clear the snapshot (e.g., on unarchive when the session
   * starts a fresh branch).
   */
  /**
   * docs/218 — read the persisted PR-status snapshot for a session (or null).
   * `SessionInfo` deliberately doesn't carry `prStatus` (it's poller-owned live
   * state), but the pre-turn auto-reset needs the merged PR's base branch +
   * number + url from the durable snapshot, which survives a container restart.
   */
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
   * docs/194 — effect-level fire-once guard for the merge→issue-lifecycle writes.
   * `key` is the effect's natural identity (PR number + issue id + verb). Returns
   * true once {@link markAppliedMergeIssueEffect} has recorded `key` for this
   * session, so the merge-completed status flip / resolved-by comment can be
   * skipped on a re-fire (a viewer reconnect wipes the poller's in-memory
   * `mergedSessions` guard; this persisted set is what makes the writes idempotent
   * across reconnects and restarts). Corrupt JSON is treated as "not applied".
   */
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

  /**
   * docs/194 — record that a merge→issue-lifecycle effect identified by `key` has
   * been applied for this session, so a later re-fire skips it. Idempotent: a key
   * already present is a no-op. Best-effort — the caller marks only after the
   * effect succeeds, so a transient tracker failure leaves the key unset and a
   * later re-fire retries it.
   */
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
        // Corrupt/legacy JSON — overwrite with a fresh array rather than crash.
      }
    }
    if (keys.includes(key)) return;
    keys.push(key);
    this.db
      .prepare("UPDATE sessions SET merge_issue_effects = ? WHERE id = ?")
      .run(JSON.stringify(keys), id);
  }

  /**
   * docs/196 — set (or clear, with `null`) the notify-on-merge watch on a
   * session row. Stored as JSON so the watch — and its `armed/merge-observed/
   * delivered/closed-unmerged` state — survives an orchestrator restart, letting
   * the in-process poller re-derive "PR merged + watch un-delivered → enqueue"
   * after a redeploy.
   */
  setMergeWatch(id: string, watch: SessionMergeWatch | null): void {
    const json = watch === null ? null : JSON.stringify(watch);
    this.db.prepare("UPDATE sessions SET merge_watch = ? WHERE id = ?").run(json, id);
  }

  /** docs/196 — read the notify-on-merge watch for a session, if any. */
  getMergeWatch(id: string): SessionMergeWatch | undefined {
    return this.get(id)?.mergeWatch;
  }

  /**
   * docs/213 / planning#317 — set (or clear, with `null`) the secret-scan commit
   * block. Persisted so the banner survives the runner being disposed on idle:
   * the credential is in the working tree, which outlives the container, so the
   * warning must too.
   */
  setSecretBlock(id: string, block: SessionSecretBlock | null): void {
    const json = block === null ? null : JSON.stringify(block);
    this.db.prepare("UPDATE sessions SET secret_block = ? WHERE id = ?").run(json, id);
  }

  /** docs/213 — read the current secret-scan commit block for a session, if any. */
  getSecretBlock(id: string): SessionSecretBlock | undefined {
    return this.get(id)?.secretBlock;
  }

  /**
   * docs/196 — every session that carries a merge-watch in a non-terminal state
   * (`armed` or `merge-observed`). Used by the startup reconcile to re-fire any
   * watch whose child PR already reached a terminal state while the orchestrator
   * was down, by the retry supervisor to find stalled deliveries (planning#260), and
   * by `PollingGlobalGate` to keep the PR poll loop alive for a viewerless child
   * awaiting a human merge. Includes archived rows (a merged child is archived
   * by the post-merge path, but its un-delivered watch must still fire).
   *
   * The terminal states — `delivered`, `closed-unmerged`, and `delivery-failed`
   * — are excluded, which is what stops a watch that has given up from holding
   * the polling gate open forever.
   */
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
        // Skip corrupt JSON rather than crash startup.
      }
    }
    return out;
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
