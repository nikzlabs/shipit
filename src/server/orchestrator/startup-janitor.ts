/**
 * Disk janitor — runs once at orchestrator startup to reclaim:
 *   - **Orphan session compose volumes** — both labeled (post-fix) and
 *     unlabeled legacy ones. Identified by the predictable compose
 *     project-name pattern `shipit-<12-hex-of-sid>_<volname>`. We
 *     cross-reference the embedded session prefix against the **active
 *     sessions in the DB** and only delete volumes whose session is no
 *     longer tracked (i.e., archived or deleted). This is critical:
 *     idle-evicted sessions leave their volumes dangling on disk by
 *     design (so a warm resume can re-attach), and a naive `docker
 *     volume prune --filter dangling=true` would silently destroy that
 *     state.
 *   - **Orphan `shipit/*` remote branches** whose PR is merged and which
 *     no live session points at. Catches the historical backlog from
 *     before `markMergedAndPruneExcess` started deleting branches at
 *     merge-detection time. Skipped if GitHub auth or the repo's bare
 *     cache isn't available. See `sweepOrphanMergedBranches` for the
 *     safety criteria (must have ≥1 merged PR, no open PR, no live
 *     session using the branch).
 *   - **Orphan session networks** — both the per-session bridge network
 *     created for Docker-enabled agent containers (`shipit-session-<12-hex>`,
 *     `container-lifecycle.ts`) and the compose network created by
 *     `docker compose up` (`shipit-session-<full-sid>`, `compose-generator.ts`).
 *     Both embed the session id after a `shipit-session-` name prefix, so
 *     the same active-sessions cross-reference used for volumes applies:
 *     a network whose session is no longer tracked is removed; an
 *     idle-evicted session's network is preserved for warm resume. The
 *     primary cleanup paths (`cleanupSessionDockerResources`, compose
 *     teardown, `killStaleContainers`) handle the happy path — this is
 *     the safety net for when they didn't run (unclean shutdown).
 *   - **Archived session workspaces** older than the cold-artifact retention
 *     (`coldArtifactRetentionDays`, default 30). SHI-197: a non-tunable
 *     crash-recovery backstop — post-SHI-192 `archiveSession` frees the
 *     workspace *synchronously* (`reclaimRegenerableSessionDirs`), so this only
 *     catches an archive whose sync cleanup crashed and normally finds nothing.
 *     Chat history, usage, and session metadata are preserved;
 *     `unarchiveSession` re-clones from the bare cache.
 *   - **Orphan `repo-cache/<hash>` and `dep-cache/<hash>` directories**
 *     whose repo URL has no `repos` row or whose `last_used_at` is older
 *     than the cold-artifact retention (`coldArtifactRetentionDays`, default 30).
 *   - **Orphan `repo-memory/<hash>` directories** (docs/155) — shared
 *     per-repo Claude memory keyed by the same repo hash. Swept on the
 *     same liveness rule as the caches above, but lives under
 *     `credentialsDir`, so it only runs when that dep is wired.
 *   - **Dead `dep-cache/<hash>/nm-store` directories** for live repos. The
 *     lockfile-keyed `node_modules` copy store (docs/148) was removed in
 *     docs/183 Phase 1 (superseded by the overlay rolling base), so the whole
 *     subtree is reclaimed wholesale (~2.4 GB observed). Effectively one-time:
 *     the worker never writes nm-store again, so later sweeps no-op.
 *   - **Obsolete `overlay-base/<scope-hash>` dirs** (docs/183 Phase 2/3, SHI-193)
 *     reclaimed by a **deterministic live-mount check, not an age cutoff**. A base
 *     scope keys on `overlayRuntimeKey` (worker-image id + arch), so a worker-image
 *     rebuild rotates every scope hash — an old-image scope goes obsolete the instant
 *     the image rolls (no future container can mount it). A scope is reclaimable the
 *     moment it has zero live mounts: the union of (a) base generations pinned by a
 *     RUNNING session-worker container right now and (b) the bases every resumable
 *     session would re-pin for the CURRENT runtime (`liveOverlayScopeHashes`). Any
 *     scope outside that union is removed immediately — no fixed delay. Gated on a
 *     `liveOverlayScopeHashes` source (Phase 3); skipped entirely until that source
 *     is wired.
 *
 * Why startup-only (no timer) for THESE sweeps: every item above is
 * recovering from a failure earlier in the lifecycle — orphan volumes only
 * exist if archive teardown crashed, orphan workspaces only exist if archive's
 * fs.rm failed, orphan caches only exist if repo removal didn't cascade, orphan
 * networks only exist if the disposal/teardown path didn't run. None
 * of them accumulate steadily, so running periodically would mostly
 * burn cycles doing nothing. Startup is the natural "we just came back
 * from possibly-unclean shutdown — clean up after the previous run" moment.
 *
 * NOTE: prod is deployed *manually*, not on push — so the orchestrator can run
 * for a long time between restarts, and a startup-only sweep can go a long time
 * between runs. That's fine for the failure-recovery items above (they don't
 * accumulate steadily), but NOT for docs/161's disk-tier escalation, which is
 * the one disk task that DOES accumulate steadily (idle node_modules piling up).
 * That ladder therefore does NOT live in `runDiskJanitor`: it's
 * `escalateDiskTiers` (`tier-escalation.ts`), invoked async after each session
 * start (the primary steady-state reclaim), at orchestrator boot, AND on a
 * low-frequency periodic timer (issue #1049 — `DISK_ESCALATION_INTERVAL_MS`,
 * hourly default, wired in `index.ts`). The timer exists specifically because
 * escalation accumulates steadily: session-start kicks alone create a self-heal
 * feedback trap (a full disk fails new starts → the kick never fires → nothing
 * reclaims). The failure-recovery sweeps above deliberately get NO such timer.
 * The startup janitor remains the post-(unclean-)restart safety net for the
 * recovery items.
 *
 * Scope split — what this DOESN'T do:
 *   - **BuildKit cache + dangling images** are pruned by `deploy.sh`
 *     right after each `docker compose build`. They only grow as a side
 *     effect of builds.
 *   - **Per-session named-volume cleanup** is performed by
 *     `ServiceManager.stop({ removeVolumes: true })` from `archiveSession`
 *     / `fullReset`. This module only sweeps the leftovers when that
 *     primary cleanup didn't happen.
 *
 * Behavior knobs (env vars):
 *   - DISK_COLD_ARTIFACT_RETENTION_DAYS: SHI-197 — the single retention (days)
 *     for ALL cold artifacts: unreferenced `repo-cache`/`dep-cache` dirs, the
 *     pnpm shared store, repo-memory dirs, and the archived-workspace
 *     crash-recovery backstop. Default `30`
 *     ({@link DEFAULT_COLD_ARTIFACT_RETENTION_DAYS}). Replaces the two
 *     coincidental-but-unrelated `DISK_JANITOR_CACHE_DAYS` /
 *     `DISK_JANITOR_ARCHIVED_WORKSPACE_DAYS` knobs.
 *   - DISK_JANITOR_ORPHAN_BRANCHES: when `"false"`, disables the
 *     orphan-`shipit/*`-branch sweep. Default enabled (set the env var to
 *     `"false"` to opt out). The sweep no-ops anyway without GitHub auth.
 *   - DISK_JANITOR_PACE_MS: milliseconds to pause between each destructive
 *     operation (volume/network removal, branch delete, cache/workspace/
 *     nm-store rm). The startup sweep is fire-and-forget and never urgent —
 *     every item recovers from a past failure — so we deliberately drip it out
 *     rather than have a burst of `docker` spawns and git pushes contend with a
 *     concurrent agent start for the Docker daemon / bare-cache git layer. This
 *     is what keeps a just-restarted box's agents responsive WITHOUT deferring
 *     the reclaim to a later (and more disruptive) moment. Default `500`.
 */

import path from "node:path";
import fs from "node:fs/promises";
import type { SessionManager } from "./sessions.js";
import type { RepoStore } from "./repo-store.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { RepoGit } from "./repo-git.js";
import { repoUrlToHash, parseGitHubRemote } from "./git-utils.js";
import { sessionCredentialsRoot, REPO_MEMORY_SUBDIR } from "./session-credentials.js";
import { OVERLAY_BASE_SUBDIR } from "./overlay-volume.js";
import { readBasePointerByHash } from "./overlay-base.js";
import { PNPM_STORE_SUBDIR } from "./overlay-session.js";
import { getMessage, sleep, defaultRunDocker, reclaimRegenerableSessionDirs } from "./disk-utils.js";

export interface DiskJanitorDeps {
  sessionManager: SessionManager;
  repoStore: RepoStore;
  /** Root that holds `repo-cache/<hash>` and `dep-cache/<hash>` subdirs. */
  stateDir: string;
  /**
   * SHI-197 — single retention (days) for ALL cold artifacts: unreferenced
   * repo/dep caches, the pnpm shared store, repo-memory dirs, AND the
   * crash-recovery archived-workspace backstop. Defaults to
   * {@link DEFAULT_COLD_ARTIFACT_RETENTION_DAYS}. Folds the former `cacheDays`
   * and `archivedWorkspaceDays` knobs — which shared a coincidental 30d but were
   * unrelated subsystems — into one number. The archived-workspace sweep is now
   * a non-tunable crash-recovery backstop on this same clock (post-SHI-192
   * archiving frees the workspace synchronously), no longer an independent knob.
   */
  coldArtifactRetentionDays?: number;
  /**
   * docs/138 — source-of-truth credentials root (e.g. `/credentials`). When
   * provided, the janitor sweeps per-session credential subtrees under
   * `<credentialsDir>/sessions/<id>` whose session is archived or no longer
   * tracked, so provisioned agent credentials don't linger on disk. Omitted in
   * tests / runtimes without container credentials.
   */
  credentialsDir?: string;
  /**
   * docs/192 — sessions root (`<workspaceDir>/sessions`). When provided, the
   * janitor sweeps per-session `logs/` dirs whose session is archived or no
   * longer tracked, so durable container logs don't outlive their session.
   * Omitted in tests / runtimes without on-disk sessions.
   */
  sessionsRoot?: string;
  /**
   * Shell-out hook for docker prune commands. Overridable for tests so we
   * never touch a real Docker daemon from unit tests. Resolves with the
   * combined stdout/stderr of the command (the "Total reclaimed space"
   * line is parsed from this).
   */
  runDocker?: (args: string[]) => Promise<string>;
  /**
   * Optional. When all three are provided AND `sweepOrphanBranches !== false`,
   * the janitor sweeps merged-PR `shipit/*` branches that were left behind
   * before the per-merge deletion hook (`markMergedAndPruneExcess`) shipped.
   * Omitted in tests that don't exercise this path; in production all three
   * are wired in `index.ts`.
   */
  githubAuthManager?: GitHubAuthManager;
  createRepoGit?: (dir: string) => RepoGit;
  getBareCacheDir?: (repoUrl: string) => string;
  /** Default true. Set false to disable the branch sweep entirely. */
  sweepOrphanBranches?: boolean;
  /**
   * docs/183 Phase 2/3, SHI-193 — overlay rolling-base GC, **resumable-session**
   * half of the liveness union. Returns the set of overlay-base scope-hashes
   * (`(repo, runtime fingerprint, dep-dir)`) that every *resumable* session would
   * re-pin **for the CURRENT runtime** on activation. The sweep unions this with
   * the base generations a RUNNING container pins right now (resolved internally
   * via `docker volume inspect`, which catches old-runtime bases an
   * old-image container is still mounting mid-turn) and removes every
   * `overlay-base/<hash>/` dir outside that union — immediately, with no age delay.
   *
   * This MUST be provided before the sweep runs: removing a base dir while it backs
   * a live overlay mount is undefined behavior, and the scope-hash keying never
   * matches the repo-url `liveHashes` set (the naive extension the plan warns
   * against). The live-scope-hash registry is built in Phase 3 when sessions record
   * their base scope; until then this is omitted and the overlay-base sweep is
   * skipped (no bases exist on disk yet anyway).
   *
   * **Completeness:** this set covers the CURRENT-runtime bases of resumable
   * sessions whose containers are idle (no running mount to observe). The
   * running-container mount check covers everything actually pinned right now,
   * including old-runtime bases. Between the two, a base is kept iff some running
   * container pins it OR some resumable session will re-pin it — which is exactly
   * "has a live mount, now or on the next resume." Returns an empty set under the
   * `OVERLAY_DEP_STORE` kill switch so the sweep stays inert when the feature is off.
   */
  liveOverlayScopeHashes?: () => Set<string>;
  /**
   * docs/197 Part 2 — pnpm shared-store GC. Returns the hash of the store dir for
   * the CURRENT runtime (`pnpm-store/<hash>`, the live store that must never be
   * swept), or `null` when the `OVERLAY_DEP_STORE=0`/`false` kill switch disables
   * the feature — in which case no store is live, so every `pnpm-store/<hash>` dir
   * past the cold-artifact retention is reapable (the same "GC the disabled feature's leftovers"
   * shape as the overlay-base sweep returning an empty live-set when killed off).
   * The sweep runs only when this dep is
   * provided; omitted in unit tests that don't exercise it.
   */
  pnpmStoreRuntimeHash?: () => string | null;
  /**
   * Throttle: milliseconds to pause between each destructive operation
   * (volume/network removal, branch delete, cache/workspace/nm-store rm). The
   * startup sweep is never urgent — every item is recovering from a past
   * failure — so we deliberately drip the reclaim out rather than hammer the
   * Docker daemon and the bare-cache git layer that a concurrent agent start
   * also needs. Defaults to `0` (no pause) so unit tests stay fast; production
   * wires a gentle pace via `DISK_JANITOR_PACE_MS` in `index.ts`.
   */
  paceMs?: number;
}

export interface DiskJanitorResult {
  /** Session-compose volumes removed (cross-referenced against active sessions). */
  orphanVolumesRemoved: number;
  /** Session networks removed (cross-referenced against active sessions). */
  orphanNetworksRemoved: number;
  workspacesRemoved: number;
  cachesRemoved: number;
  /** docs/183 — dead `dep-cache/<hash>/nm-store` dirs removed (supersedes docs/148). */
  nmStoresRemoved: number;
  /** docs/183 Phase 2/3 — stale, unreferenced `overlay-base/<hash>` dirs removed. */
  overlayBasesRemoved: number;
  /** docs/197 Part 2 — stale `pnpm-store/<hash>` dirs removed (non-current runtime, past cutoff). */
  pnpmStoresRemoved: number;
  /** Remote `shipit/*` branches whose PR is merged and no live session uses them. */
  orphanBranchesRemoved: number;
  /** Per-session credential subtrees removed (archived or untracked sessions). */
  credentialDirsRemoved: number;
  /** docs/155 — shared per-repo Claude memory dirs removed (unreferenced repo hash). */
  repoMemoryDirsRemoved: number;
  /** docs/192 — per-session `logs/` dirs removed (archived or untracked sessions). */
  logDirsRemoved: number;
}

/**
 * SHI-197 — the single cold-artifact retention default. Replaces the two
 * coincidental 30d knobs (`DISK_JANITOR_CACHE_DAYS` / unrelated
 * `DISK_JANITOR_ARCHIVED_WORKSPACE_DAYS`) with one constant covering caches,
 * pnpm/repo-memory stores, and the archived-workspace crash-recovery backstop.
 */
export const DEFAULT_COLD_ARTIFACT_RETENTION_DAYS = 30;

/**
 * Run the disk-janitor sweep once. Each sub-step is wrapped in try/catch
 * so one failing reclaim doesn't block the others. Always resolves —
 * never rejects — so callers can fire-and-forget at startup without
 * needing a `.catch`.
 */
export async function runDiskJanitor(deps: DiskJanitorDeps): Promise<DiskJanitorResult> {
  const result: DiskJanitorResult = {
    orphanVolumesRemoved: 0,
    orphanNetworksRemoved: 0,
    workspacesRemoved: 0,
    cachesRemoved: 0,
    nmStoresRemoved: 0,
    overlayBasesRemoved: 0,
    pnpmStoresRemoved: 0,
    orphanBranchesRemoved: 0,
    credentialDirsRemoved: 0,
    repoMemoryDirsRemoved: 0,
    logDirsRemoved: 0,
  };
  const runDocker = deps.runDocker ?? defaultRunDocker;
  const paceMs = deps.paceMs ?? 0;
  // SHI-197 — one retention clock for every cold artifact below.
  const retentionDays = deps.coldArtifactRetentionDays ?? DEFAULT_COLD_ARTIFACT_RETENTION_DAYS;

  try {
    result.orphanVolumesRemoved = await sweepOrphanSessionVolumes(
      deps.sessionManager, runDocker, paceMs,
    );
  } catch (err) {
    console.warn("[disk-janitor] orphan volume sweep failed:", getMessage(err));
  }

  try {
    result.orphanNetworksRemoved = await sweepOrphanSessionNetworks(
      deps.sessionManager, runDocker, paceMs,
    );
  } catch (err) {
    console.warn("[disk-janitor] orphan network sweep failed:", getMessage(err));
  }

  try {
    result.workspacesRemoved = await sweepArchivedWorkspaces(
      deps.sessionManager, retentionDays, paceMs,
    );
  } catch (err) {
    console.warn("[disk-janitor] archived-workspace sweep failed:", getMessage(err));
  }

  try {
    result.cachesRemoved = await sweepOrphanedCaches(
      deps.stateDir, deps.repoStore, retentionDays, paceMs,
    );
  } catch (err) {
    console.warn("[disk-janitor] cache sweep failed:", getMessage(err));
  }

  try {
    result.nmStoresRemoved = await sweepDeadNmStores(
      deps.stateDir, deps.repoStore, paceMs,
    );
  } catch (err) {
    console.warn("[disk-janitor] nm-store sweep failed:", getMessage(err));
  }

  // docs/183 Phase 2/3, SHI-193 — sweep obsolete overlay bases via a deterministic
  // live-mount check (not an age cutoff). Gated on a live-scope-hash source (Phase
  // 3): removing a base dir that still backs a live overlay `lowerdir` is undefined
  // behavior, so without a way to confirm which bases are in use we don't touch the
  // subtree at all.
  if (deps.liveOverlayScopeHashes) {
    try {
      result.overlayBasesRemoved = await sweepOrphanedOverlayBases(
        deps.stateDir,
        deps.liveOverlayScopeHashes(),
        runDocker,
        paceMs,
      );
    } catch (err) {
      console.warn("[disk-janitor] overlay-base sweep failed:", getMessage(err));
    }
  }

  // docs/197 Part 2 — sweep stale pnpm shared stores. Gated on a runtime-hash
  // source (mirrors the overlay-base gate): without a way to know which store is
  // live, we don't touch the subtree at all.
  if (deps.pnpmStoreRuntimeHash) {
    try {
      result.pnpmStoresRemoved = await sweepStalePnpmStores(
        deps.stateDir,
        deps.pnpmStoreRuntimeHash(),
        retentionDays,
        paceMs,
      );
    } catch (err) {
      console.warn("[disk-janitor] pnpm-store sweep failed:", getMessage(err));
    }
  }

  if (deps.credentialsDir) {
    try {
      result.credentialDirsRemoved = await sweepOrphanCredentialDirs(
        deps.sessionManager, deps.credentialsDir, paceMs,
      );
    } catch (err) {
      console.warn("[disk-janitor] credential-dir sweep failed:", getMessage(err));
    }
    try {
      result.repoMemoryDirsRemoved = await sweepOrphanedRepoMemory(
        deps.credentialsDir, deps.repoStore, retentionDays, paceMs,
      );
    } catch (err) {
      console.warn("[disk-janitor] repo-memory sweep failed:", getMessage(err));
    }
  }

  if (deps.sessionsRoot) {
    try {
      result.logDirsRemoved = await sweepOrphanSessionLogs(
        deps.sessionManager, deps.sessionsRoot, paceMs,
      );
    } catch (err) {
      console.warn("[disk-janitor] session-logs sweep failed:", getMessage(err));
    }
  }

  if (
    deps.sweepOrphanBranches !== false
    && deps.githubAuthManager
    && deps.createRepoGit
    && deps.getBareCacheDir
  ) {
    try {
      result.orphanBranchesRemoved = await sweepOrphanMergedBranches(
        deps.sessionManager,
        deps.repoStore,
        deps.githubAuthManager,
        deps.createRepoGit,
        deps.getBareCacheDir,
        paceMs,
      );
    } catch (err) {
      console.warn("[disk-janitor] orphan-branch sweep failed:", getMessage(err));
    }
  }

  console.log(
    `[disk-janitor] reclaimed orphan-volumes=${result.orphanVolumesRemoved} `
    + `orphan-networks=${result.orphanNetworksRemoved} `
    + `workspaces=${result.workspacesRemoved} `
    + `caches=${result.cachesRemoved} `
    + `nm-stores=${result.nmStoresRemoved} `
    + `overlay-bases=${result.overlayBasesRemoved} `
    + `pnpm-stores=${result.pnpmStoresRemoved} `
    + `orphan-branches=${result.orphanBranchesRemoved} `
    + `credential-dirs=${result.credentialDirsRemoved} `
    + `repo-memory=${result.repoMemoryDirsRemoved} `
    + `log-dirs=${result.logDirsRemoved}`,
  );
  return result;
}

/**
 * docs/138 — remove per-session credential subtrees under
 * `<credentialsDir>/sessions/<id>` whose session is archived or no longer
 * tracked in the DB. These hold copies of the pinned agent's credentials
 * (provisioned on first turn); they should not outlive the session.
 *
 * Preserved: dirs for **live, non-user-archived** sessions — i.e. sessions
 * still in `allIds()` and NOT user-archived. SHI-179: a disk-EVICTED session
 * (`listArchived()` = `disk_tier = 'evicted'`) is NOT eligible — it is still
 * live state the user can return to (its workspace re-clones from the bare
 * cache on activation), so its credentials must survive. Only genuinely-gone
 * (untracked) or USER-archived sessions are reaped. An archived session that's
 * later unarchived simply re-provisions on its next first turn / container create.
 *
 * Returns the count of subtrees removed.
 */
async function sweepOrphanCredentialDirs(
  sessionManager: SessionManager,
  credentialsDir: string,
  paceMs: number,
): Promise<number> {
  const root = sessionCredentialsRoot(credentialsDir);
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return 0; // No per-session credentials dir yet — nothing to sweep.
  }

  const tracked = new Set(sessionManager.allIds());
  // SHI-179: key off USER-archive state, not `disk_tier = 'evicted'`. A
  // disk-evicted but non-user-archived session is live and must keep its
  // credentials; only an explicit user-archive (or a deleted/untracked row)
  // makes them reclaimable.
  const userArchived = new Set(
    sessionManager.listAll().filter((s) => s.userArchived).map((s) => s.id),
  );
  // docs/110 — defense-in-depth: never sweep a pinned (persistent) session's
  // credentials. Such a session is already tracked-and-not-archived, so the
  // check below keeps it; this makes the persistence invariant explicit.
  const pinned = new Set(sessionManager.listAll().filter((s) => s.pinnedAt).map((s) => s.id));

  let removed = 0;
  for (const entry of entries) {
    if (pinned.has(entry)) continue;
    // Keep dirs for sessions that are still tracked AND not user-archived.
    if (tracked.has(entry) && !userArchived.has(entry)) continue;
    const full = path.join(root, entry);
    try {
      await sleep(paceMs);
      await fs.rm(full, { recursive: true, force: true });
      removed += 1;
      console.log(`[disk-janitor] removed orphan credentials dir ${full}`);
    } catch (err) {
      console.warn(`[disk-janitor] failed to remove ${full}:`, getMessage(err));
    }
  }
  return removed;
}

/**
 * docs/155 — remove shared per-repo Claude memory dirs under
 * `<credentialsDir>/repo-memory/<repoHash>` whose repo hash is no longer
 * referenced by a recently-used repo. Keyed exactly like
 * {@link sweepOrphanedCaches}: a hash is "live" iff some `repos` row resolves to
 * it AND that repo's `lastUsedAt` is within `days`. An orphaned memory dir is
 * one whose repo was removed or has gone untouched past the cutoff.
 *
 * Memory is regeneratable accumulation, not the only copy of anything, so this
 * is safe to do without coordinating with live sessions — same posture as the
 * cache sweep. Returns the count of memory dirs removed.
 */
async function sweepOrphanedRepoMemory(
  credentialsDir: string,
  repoStore: RepoStore,
  days: number,
  paceMs: number,
): Promise<number> {
  const cutoffMs = Date.now() - days * 86_400_000;
  const liveHashes = new Set<string>();
  for (const repo of repoStore.list()) {
    const lastUsedMs = Date.parse(repo.lastUsedAt);
    if (Number.isFinite(lastUsedMs) && lastUsedMs >= cutoffMs) {
      liveHashes.add(repoUrlToHash(repo.url));
    }
  }

  const dir = path.join(credentialsDir, REPO_MEMORY_SUBDIR);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0; // No repo-memory subtree yet — nothing to sweep.
  }

  let removed = 0;
  for (const entry of entries) {
    if (liveHashes.has(entry)) continue;
    const full = path.join(dir, entry);
    try {
      await sleep(paceMs);
      await fs.rm(full, { recursive: true, force: true });
      removed += 1;
      console.log(`[disk-janitor] removed orphan repo-memory ${full}`);
    } catch (err) {
      console.warn(`[disk-janitor] failed to remove ${full}:`, getMessage(err));
    }
  }
  return removed;
}

/**
 * docs/192 — remove per-session `logs/` dirs (`<sessionsRoot>/<id>/logs`) whose
 * session is archived or no longer tracked. Container logs are durable scratch:
 * they should not outlive the session, and — unlike {@link sweepArchivedWorkspaces}
 * — there is NO `!remoteUrl` skip, because a log dir is always disposable (it's
 * never the only copy of the user's work). An archived session that is later
 * unarchived simply starts a fresh log backlog.
 *
 * Preserved: dirs for live, non-user-archived sessions (still in `allIds()` and
 * NOT user-archived), and pinned sessions — mirrors the credential-dir sweep so
 * warm / disk-evicted sessions keep their logs for resume. SHI-179: a
 * disk-evicted (`listArchived()`) but non-user-archived session is live, so it
 * is NOT eligible for reaping.
 *
 * Returns the count of `logs/` dirs removed.
 */
async function sweepOrphanSessionLogs(
  sessionManager: SessionManager,
  sessionsRoot: string,
  paceMs: number,
): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsRoot);
  } catch {
    return 0; // No sessions root yet — nothing to sweep.
  }

  const tracked = new Set(sessionManager.allIds());
  // SHI-179 — key off USER-archive state, not disk eviction (see the
  // credential-dir sweep): a disk-evicted but non-user-archived session is live.
  const userArchived = new Set(
    sessionManager.listAll().filter((s) => s.userArchived).map((s) => s.id),
  );
  const pinned = new Set(sessionManager.listAll().filter((s) => s.pinnedAt).map((s) => s.id));

  let removed = 0;
  for (const entry of entries) {
    if (pinned.has(entry)) continue;
    if (tracked.has(entry) && !userArchived.has(entry)) continue;
    const logsDir = path.join(sessionsRoot, entry, "logs");
    try {
      // Only count it if there was actually a logs dir to remove.
      await fs.stat(logsDir);
    } catch {
      continue;
    }
    try {
      await sleep(paceMs);
      await fs.rm(logsDir, { recursive: true, force: true });
      removed += 1;
      console.log(`[disk-janitor] removed orphan logs dir ${logsDir}`);
    } catch (err) {
      console.warn(`[disk-janitor] failed to remove ${logsDir}:`, getMessage(err));
    }
  }
  return removed;
}

/**
 * Remove session-compose named volumes whose session is no longer
 * tracked in the active sessions list — handles both labeled
 * (`shipit-managed=true`, post-fix) and unlabeled legacy volumes
 * uniformly. Volumes are identified by the predictable compose
 * project-name pattern:
 *
 *     shipit-<first-12-chars-of-sessionId>_<volname>
 *
 * The 12-char prefix is extracted and cross-referenced against
 * `sessionManager.list()` (active, non-archived sessions). If the
 * prefix matches an active session, the volume is preserved — this is
 * critical for **idle-evicted** sessions whose containers are gone but
 * whose volumes must remain on disk for a warm resume. A naive
 * `docker volume prune --filter dangling=true` would silently destroy
 * that state.
 *
 * Safety properties:
 *   - The orchestrator's own data volumes start with `shipit_`
 *     (underscore), never `shipit-`, so they can't match.
 *   - Regex check rejects volume names a user might have created
 *     (e.g. `shipit-foo`); only names matching the strict
 *     `shipit-<12 hex/hyphen chars>_` shape are considered.
 *   - `--filter dangling=true` is still applied as defence-in-depth —
 *     docker returns only unattached volumes, so an attached
 *     currently-active session's volumes are invisible to the sweep.
 *
 * Returns the count of volumes actually removed.
 */
async function sweepOrphanSessionVolumes(
  sessionManager: SessionManager,
  runDocker: (args: string[]) => Promise<string>,
  paceMs: number,
): Promise<number> {
  const SESSION_VOLUME_RE = /^shipit-([a-f0-9-]{12})_/;

  // Preserve volumes for every session that still holds on-disk state, i.e.
  // anything not `evicted`. `list()` would exclude merged sessions that fell
  // out of the sidebar's top-N view even though they're still `hot` — their
  // volumes must survive for a warm resume.
  const livePrefixes = new Set(
    sessionManager.listAll()
      .filter((s) => s.diskTier !== "evicted")
      .map((s) => s.id.slice(0, 12).toLowerCase()),
  );

  let listOut: string;
  try {
    listOut = await runDocker([
      "volume", "ls", "-q",
      "--filter", "name=shipit-",
      "--filter", "dangling=true",
    ]);
  } catch (err) {
    console.warn("[disk-janitor] volume ls failed:", getMessage(err));
    return 0;
  }

  const toRemove: string[] = [];
  for (const raw of listOut.split("\n")) {
    const name = raw.trim();
    if (!name) continue;
    const m = SESSION_VOLUME_RE.exec(name);
    if (!m) continue;
    const prefix = m[1].toLowerCase();
    if (livePrefixes.has(prefix)) continue;
    toRemove.push(name);
  }

  let removed = 0;
  for (const name of toRemove) {
    try {
      await sleep(paceMs);
      await runDocker(["volume", "rm", name]);
      removed += 1;
    } catch {
      // Volume might have just been attached or already removed by a
      // concurrent sweep — both are fine, skip silently.
    }
  }
  if (removed > 0) {
    console.log(`[disk-janitor] removed ${removed} orphan session volume(s)`);
  }
  return removed;
}

/**
 * Remove session networks whose session is no longer tracked in the
 * active sessions list. Two network shapes are created per session and
 * both are handled here uniformly:
 *
 *   - `shipit-session-<first-12-chars-of-sessionId>` — the per-session
 *     bridge network for Docker-enabled agent containers
 *     (`container-lifecycle.ts:createContainer`).
 *   - `shipit-session-<full-sessionId>` — the compose network created by
 *     `docker compose up` from the generated override
 *     (`compose-generator.ts`).
 *
 * Both embed the session id directly after the `shipit-session-` name
 * prefix, and the first 12 characters of that id are always
 * `sessionId.slice(0, 12)` — the same key `sweepOrphanSessionVolumes`
 * cross-references. So we extract those 12 chars and preserve any
 * network whose session is still tracked (critical for idle-evicted
 * sessions, whose container/services are gone but whose row remains in
 * the DB for a warm resume).
 *
 * Safety properties:
 *   - `--filter dangling=true` is applied as defence-in-depth — Docker
 *     only returns networks with no attached containers, so an active
 *     session's network (agent container or running compose services
 *     attached) is invisible to the sweep.
 *   - The strict `^shipit-session-([a-f0-9-]{12})` regex rejects any
 *     network a user might have named `shipit-session-foo`.
 *
 * Returns the count of networks actually removed.
 */
async function sweepOrphanSessionNetworks(
  sessionManager: SessionManager,
  runDocker: (args: string[]) => Promise<string>,
  paceMs: number,
): Promise<number> {
  const SESSION_NETWORK_RE = /^shipit-session-([a-f0-9-]{12})/;

  // Preserve networks for every session that still holds on-disk state, i.e.
  // anything not `evicted` (see `sweepOrphanSessionVolumes` for why `list()`
  // is too narrow here).
  const livePrefixes = new Set(
    sessionManager.listAll()
      .filter((s) => s.diskTier !== "evicted")
      .map((s) => s.id.slice(0, 12).toLowerCase()),
  );

  let listOut: string;
  try {
    listOut = await runDocker([
      "network", "ls",
      "--filter", "name=shipit-session-",
      "--filter", "dangling=true",
      "--format", "{{.Name}}",
    ]);
  } catch (err) {
    console.warn("[disk-janitor] network ls failed:", getMessage(err));
    return 0;
  }

  const toRemove: string[] = [];
  for (const raw of listOut.split("\n")) {
    const name = raw.trim();
    if (!name) continue;
    const m = SESSION_NETWORK_RE.exec(name);
    if (!m) continue;
    const prefix = m[1].toLowerCase();
    if (livePrefixes.has(prefix)) continue;
    toRemove.push(name);
  }

  let removed = 0;
  for (const name of toRemove) {
    try {
      await sleep(paceMs);
      await runDocker(["network", "rm", name]);
      removed += 1;
    } catch {
      // Network might have just been attached or already removed by a
      // concurrent sweep — both are fine, skip silently.
    }
  }
  if (removed > 0) {
    console.log(`[disk-janitor] removed ${removed} orphan session network(s)`);
  }
  return removed;
}

/**
 * Delete `workspaceDir` for USER-archived sessions whose `last_used_at` is
 * older than `days` (SHI-197: the shared cold-artifact retention, not an
 * independent knob). Chat history, usage, and session metadata are preserved —
 * `unarchiveSession` re-clones from the bare cache when the user restores the
 * session.
 *
 * SHI-197: this is a pure crash-recovery BACKSTOP, not a user-tunable cleanup.
 * Post-SHI-192 `archiveSession` frees the workspace *synchronously*
 * (`reclaimRegenerableSessionDirs` in `services/session.ts`), so on a healthy
 * host this only ever catches an archive whose synchronous cleanup crashed.
 * It therefore runs on the single cold-retention clock rather than its own
 * threshold (the `days <= 0` guard remains purely defensive).
 *
 * SHI-179: `listArchived()` returns `disk_tier = 'evicted'` sessions, which
 * also covers non-user-archived sessions reclaimed by the docs/161 disk ladder.
 * Those remain live (re-cloned on activation), so the loop skips any session
 * the user did not explicitly archive — the workspace lifecycle is tied to
 * user-archive state, not disk tier.
 *
 * In the current product all sessions have a `remoteUrl`, so on a healthy host
 * this sweep is a no-op. It exists as a safety net for:
 *   - archives that failed mid-flight (worker crash, fs error)
 *   - legacy sessions from before the cleanup code shipped
 *   - any future edge case where the workspace outlives the archive
 *
 * Sessions without a `remoteUrl` are skipped defensively — if such a
 * session ever ends up archived (test fixtures, legacy data), there is
 * no remote to re-clone from, so deleting its workspace would lose
 * irretrievable user work.
 *
 * Returns the count of workspaces actually removed.
 */
async function sweepArchivedWorkspaces(
  sessionManager: SessionManager,
  days: number,
  paceMs: number,
): Promise<number> {
  if (days <= 0) return 0;
  const cutoffMs = Date.now() - days * 86_400_000;
  const archived = sessionManager.listArchived();
  let removed = 0;
  for (const session of archived) {
    if (!session.workspaceDir) continue;
    // SHI-179 — `listArchived()` is `disk_tier = 'evicted'`, which includes
    // non-user-archived sessions reclaimed by the docs/161 disk ladder. Those
    // are LIVE state the user can return to (workspace re-clones from the bare
    // cache on activation), so this safety-net sweep must never reclaim them.
    // Only a session the user explicitly archived is eligible — its workspace
    // is re-cloned by `unarchiveSession` on restore.
    if (!session.userArchived) continue;
    // docs/110 — defensive: never sweep a pinned (persistent) session. Archive
    // clears the pin, so a pinned session is never in `listArchived()` to begin
    // with; this guard states the invariant in code rather than relying on it.
    if (session.pinnedAt) continue;
    // Defensive: never sweep a session without a remoteUrl — even though
    // the product guarantees every session has one, a stale row from a
    // prior schema or a test fixture could land here, and deleting the
    // workspace would be unrecoverable.
    if (!session.remoteUrl) continue;
    const lastUsedMs = Date.parse(session.lastUsedAt);
    if (!Number.isFinite(lastUsedMs) || lastUsedMs >= cutoffMs) continue;
    // SHI-192 — reclaim the checkout AND the regenerable overlay/ sibling,
    // preserving durable siblings (uploads/). The legacy code rm'd only the
    // checkout and orphaned the overlay upper, leaking ~60 GB on prod. Because
    // each target is stat-checked independently, this also catches sessions
    // whose `workspace/` was already removed by a prior reclaim but whose
    // `overlay/` orphan survived — the exact leak shape this sweep must mop up.
    const { removed: removedDirs, failed } = await reclaimRegenerableSessionDirs(
      session.workspaceDir,
      { paceMs },
    );
    if (removedDirs.length > 0) {
      removed += 1;
      console.log(
        `[disk-janitor] reclaimed archived session ${session.id}: ${removedDirs.join(", ")}`,
      );
    }
    for (const f of failed) {
      console.warn(
        `[disk-janitor] failed to remove ${f.dir} for ${session.id}:`,
        f.message,
      );
    }
  }
  return removed;
}

/**
 * Remove `repo-cache/<hash>` and `dep-cache/<hash>` directories whose hash
 * doesn't appear in the active repos table OR whose repo `lastUsedAt` is
 * older than `days`. Bare clones / dep caches can always be recreated, so
 * this is safe to do without coordinating with active sessions.
 */
async function sweepOrphanedCaches(
  stateDir: string,
  repoStore: RepoStore,
  days: number,
  paceMs: number,
): Promise<number> {
  const cutoffMs = Date.now() - days * 86_400_000;
  const repos = repoStore.list();
  const liveHashes = new Set<string>();
  for (const repo of repos) {
    const lastUsedMs = Date.parse(repo.lastUsedAt);
    if (Number.isFinite(lastUsedMs) && lastUsedMs >= cutoffMs) {
      liveHashes.add(repoUrlToHash(repo.url));
    }
  }

  let removed = 0;
  for (const subdir of ["repo-cache", "dep-cache"]) {
    const dir = path.join(stateDir, subdir);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (liveHashes.has(entry)) continue;
      const full = path.join(dir, entry);
      try {
        await sleep(paceMs);
        await fs.rm(full, { recursive: true, force: true });
        removed += 1;
        console.log(`[disk-janitor] removed orphan cache ${full}`);
      } catch (err) {
        console.warn(`[disk-janitor] failed to remove ${full}:`, getMessage(err));
      }
    }
  }
  return removed;
}

/**
 * docs/183 Phase 1 — reclaim the now-dead lockfile-keyed `node_modules` copy
 * store. The `nm-store` fast path (docs/148) was deleted; the overlay rolling
 * base supersedes it, so the entire `dep-cache/<repoHash>/nm-store/` subtree is
 * dead weight (~2.4 GB observed on prod). Remove the whole directory under each
 * tracked repo. (Untracked repos' `dep-cache/<hash>` is removed wholesale by
 * `sweepOrphanedCaches`, which covers their nm-store too.)
 *
 * One-time in effect: once removed, the worker never writes nm-store again, so
 * subsequent startup sweeps find nothing and no-op.
 */
async function sweepDeadNmStores(
  stateDir: string,
  repoStore: RepoStore,
  paceMs: number,
): Promise<number> {
  const liveHashes = new Set(repoStore.list().map((r) => repoUrlToHash(r.url)));

  let removed = 0;
  for (const repoHash of liveHashes) {
    const nmRoot = path.join(stateDir, "dep-cache", repoHash, "nm-store");
    try {
      await fs.stat(nmRoot);
    } catch {
      continue; // No nm-store for this repo — nothing to do.
    }
    try {
      await sleep(paceMs);
      await fs.rm(nmRoot, { recursive: true, force: true });
      removed += 1;
      console.log(`[disk-janitor] removed dead nm-store ${nmRoot}`);
    } catch (err) {
      console.warn(`[disk-janitor] failed to remove ${nmRoot}:`, getMessage(err));
    }
  }
  return removed;
}

/**
 * Crash-orphaned `.tmp-*` materialize copies (left by a publish that died after
 * the copy but before the rename) are never overlay-mounted, so the live-mount
 * check can't speak to them. But a publish running concurrently with the sweep is
 * mid-write into one — so they get a short fixed grace window (well above any
 * publish's wall-clock, far below the obsolete 30-day cutoff) instead of an
 * immediate delete. This is the ONLY age guard left in the overlay-base sweep.
 */
const OVERLAY_TMP_GRACE_MS = 60 * 60 * 1000; // 1 hour

/**
 * docs/183 Phase 2/3, SHI-193 — reclaim obsolete overlay bases under
 * `<stateDir>/overlay-base/<scope-hash>/` via a **deterministic live-mount check**,
 * not an age cutoff.
 *
 * A base scope keys on `overlayRuntimeKey` (worker-image id + arch), so a
 * worker-image rebuild rotates every scope hash — an old-image scope is obsolete
 * the instant the image rolls, because no future container can mount it (new
 * containers compute the new scope hash). The 30-day age proxy this replaced
 * therefore over-retained badly (measured: 46 of 47 prod scope dirs, ~26 GB, were
 * dead old-image scopes a 30-day window kept alive) and was unsafe at the boundary
 * (a 31-day-old scope could in principle still be mounted). The live-mount check is
 * exact in both directions.
 *
 * A scope is reclaimable the moment it has ZERO live mounts. "Live" is the union of:
 *
 *   1. **Running-container mounts** — the base generations a RUNNING session-worker
 *      container pins as its overlay `lowerdir` right now, read from
 *      `docker volume inspect` (`liveMountedOverlayBaseGenerations`). This is the
 *      authoritative signal and the ONLY thing that can pin an old-runtime base —
 *      e.g. a container created under the old image still running mid-turn when a
 *      new image deploys. Its base stays pinned until it exits, then drops.
 *   2. **Resumable-session bases** — `resumableScopeHashes`, the CURRENT-runtime
 *      bases every idle (non-evicted) session would re-pin on activation. Covers
 *      sessions whose containers aren't running now, so there's no mount to observe.
 *
 * Any `overlay-base/<hash>/` whose scope-hash is in neither set is removed
 * immediately. For a scope that IS live, the scope dir is kept and only its
 * superseded generations are reaped — see `sweepStaleBaseGenerations`.
 *
 * The repo-url `liveHashes` set used by `sweepOrphanedCaches` is deliberately NOT
 * reused: an overlay-base scope-hash keys on `(repo, runtime fingerprint, dep-dir)`,
 * so it never appears in a repo-url-keyed set — a naive extension would delete every
 * live base on the first run.
 *
 * If the docker queries fail, `liveMountedOverlayBaseGenerations` returns an empty
 * set: the sweep then relies solely on `resumableScopeHashes`, which still protects
 * every current-runtime base. The only thing lost on a docker failure is the
 * protection for an old-runtime base of a still-running old-image container — and
 * the sweep is fire-and-forget at startup, retried next boot, so a transient failure
 * just defers that one reclaim.
 */
async function sweepOrphanedOverlayBases(
  stateDir: string,
  resumableScopeHashes: Set<string>,
  runDocker: (args: string[]) => Promise<string>,
  paceMs: number,
): Promise<number> {
  const dir = path.join(stateDir, OVERLAY_BASE_SUBDIR);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0; // No overlay-base subtree yet — nothing to sweep.
  }

  // The exact `<hash>/g<N>` generations a running container pins right now, and the
  // scope hashes derived from them — unioned with the resumable-session bases.
  const liveGenKeys = await liveMountedOverlayBaseGenerations(runDocker);
  const liveScopeHashes = new Set(resumableScopeHashes);
  for (const key of liveGenKeys) liveScopeHashes.add(key.split("/")[0]);

  let removed = 0;
  for (const entry of entries) {
    if (liveScopeHashes.has(entry)) {
      // Live scope — never remove the scope dir, but reap its superseded
      // generations (bases are immutable `g<N>` children: each publish creates
      // the next generation and moves the pointer, so old ones accumulate).
      removed += await sweepStaleBaseGenerations(
        stateDir, path.join(dir, entry), entry, liveGenKeys, paceMs,
      );
      continue;
    }
    const full = path.join(dir, entry);
    try {
      // lstat, not stat: a symlink named like a scope-hash must never be treated
      // as a base dir (and never have its target followed).
      const st = await fs.lstat(full);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    try {
      await sleep(paceMs);
      await fs.rm(full, { recursive: true, force: true });
      removed += 1;
      console.log(`[disk-janitor] removed obsolete overlay base ${full} (no live mount)`);
    } catch (err) {
      console.warn(`[disk-janitor] failed to remove ${full}:`, getMessage(err));
    }
  }
  return removed;
}

/**
 * Reap superseded generations inside one LIVE scope dir, via the live-mount check
 * (SHI-193). A `g<N>` child is removed UNLESS it is one of:
 *   - `g0` — the empty cold-start lowerdir; cold mounts pin it and it costs nothing.
 *   - the pointer's current generation — the base a fresh/resuming session mounts.
 *   - a generation in `liveGenKeys` — pinned as a `lowerdir` by a running container
 *     right now (e.g. a container created before the last publish advanced the
 *     pointer; it keeps mounting the older generation until it exits).
 * Everything else has no live mount and is reclaimable immediately — no age delay.
 * Crash-orphaned `.tmp-*` copies get the short `OVERLAY_TMP_GRACE_MS` window instead
 * (they're never mounted, but an in-flight publish may be writing one).
 */
async function sweepStaleBaseGenerations(
  stateDir: string,
  scopeDir: string,
  scopeHash: string,
  liveGenKeys: Set<string>,
  paceMs: number,
): Promise<number> {
  let children: string[];
  try {
    children = await fs.readdir(scopeDir);
  } catch {
    return 0;
  }
  const currentGen = readBasePointerByHash(stateDir, scopeHash)?.generation ?? null;
  const tmpCutoffMs = Date.now() - OVERLAY_TMP_GRACE_MS;

  let removed = 0;
  for (const child of children) {
    const isTmp = child.startsWith(".tmp-");
    const genMatch = /^g(\d+)$/.exec(child);
    if (!isTmp && !genMatch) continue; // unknown entry — never touch.
    const full = path.join(scopeDir, child);
    if (genMatch) {
      const gen = Number(genMatch[1]);
      if (gen === 0) continue; // empty cold-start lowerdir — always kept.
      if (currentGen !== null && gen === currentGen) continue; // current base.
      if (liveGenKeys.has(`${scopeHash}/g${gen}`)) continue; // pinned by a running container.
    }
    try {
      const st = await fs.lstat(full);
      if (!st.isDirectory()) continue;
      // `.tmp-*` crash orphans: never mounted, but guard against racing an
      // in-flight publish with a short grace window (the lone age guard left).
      if (isTmp && st.mtimeMs >= tmpCutoffMs) continue;
    } catch {
      continue;
    }
    try {
      await sleep(paceMs);
      await fs.rm(full, { recursive: true, force: true });
      removed += 1;
      console.log(`[disk-janitor] removed stale overlay base generation ${full}`);
    } catch (err) {
      console.warn(`[disk-janitor] failed to remove ${full}:`, getMessage(err));
    }
  }
  return removed;
}

/**
 * SHI-193 — enumerate the overlay base generations currently pinned as a
 * `lowerdir` by a RUNNING session-worker container. This is the deterministic
 * "is this base live?" signal that replaces the old 30-day age proxy.
 *
 * Mechanism (exactly the issue's recipe): list running containers, read their
 * mounted overlay volume names (`shipit-<id12>_overlay…`), then
 * `docker volume inspect … {{.Options.o}}` each to recover the
 * `lowerdir=…/overlay-base/<hash>/g<N>` its driver option encodes.
 *
 * We gate on RUNNING containers, NOT "the volume exists on disk": an idle
 * (non-evicted) session keeps its overlay volume for a warm resume, but on resume
 * `createOverlayVolume` removes+recreates it against the CURRENT-runtime base — so
 * a lingering idle volume never re-pins its (possibly old-runtime) lowerdir and
 * must not keep an obsolete scope alive. Idle sessions' current-runtime bases are
 * covered by the resumable-session union in the caller.
 *
 * Returns a set of `<hash>/g<N>` keys (one per mounted base generation). Any docker
 * failure resolves to an empty set; the caller treats that conservatively (it still
 * protects current-runtime bases via the resumable-session union).
 */
async function liveMountedOverlayBaseGenerations(
  runDocker: (args: string[]) => Promise<string>,
): Promise<Set<string>> {
  const keys = new Set<string>();

  let psOut: string;
  try {
    psOut = await runDocker(["ps", "-q"]);
  } catch (err) {
    console.warn("[disk-janitor] docker ps failed (overlay live-mount check):", getMessage(err));
    return keys;
  }
  const ids = psOut.split("\n").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return keys;

  let inspectOut: string;
  try {
    inspectOut = await runDocker([
      "container", "inspect",
      "--format", "{{range .Mounts}}{{println .Name}}{{end}}",
      ...ids,
    ]);
  } catch (err) {
    console.warn(
      "[disk-janitor] docker container inspect failed (overlay live-mount check):",
      getMessage(err),
    );
    return keys;
  }
  // Overlay volume names match the per-session pattern (overlay-volume.ts); only
  // session-worker agent containers mount them, so this filter selects exactly
  // the live overlay mounts without needing a label filter on `docker ps`.
  const OVERLAY_VOL_RE = /^shipit-[a-f0-9-]{12}_overlay/;
  const volNames = new Set(
    inspectOut.split("\n").map((s) => s.trim()).filter((n) => OVERLAY_VOL_RE.test(n)),
  );
  if (volNames.size === 0) return keys;

  let volOut: string;
  try {
    volOut = await runDocker([
      "volume", "inspect",
      "--format", "{{.Options.o}}",
      ...volNames,
    ]);
  } catch (err) {
    console.warn(
      "[disk-janitor] docker volume inspect failed (overlay live-mount check):",
      getMessage(err),
    );
    return keys;
  }
  // `o` is `lowerdir=…/overlay-base/<hash>/g<N>,upperdir=…,workdir=…`. The scope
  // hash (16 hex) + generation appear only in the `overlay-base/` lowerdir segment;
  // the upper/work dirs live under `sessions/<id>/overlay/`, never `overlay-base/`.
  const GEN_RE = /overlay-base\/([0-9a-f]{16})\/g(\d+)/g;
  for (const line of volOut.split("\n")) {
    GEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = GEN_RE.exec(line)) !== null) {
      keys.add(`${m[1]}/g${m[2]}`);
    }
  }
  return keys;
}

/**
 * docs/197 Part 2 — reclaim stale pnpm shared stores under
 * `<stateDir>/pnpm-store/<runtimeKey-hash>/`.
 *
 * One store per runtime fingerprint; a worker-image rebuild rotates the hash, so
 * the previous runtime's store is left behind. A dir is removed only when BOTH:
 *
 *   1. Its hash is NOT `liveHash` (the current runtime's store, or null when the
 *      feature is off — then nothing is live and every store is a candidate). The
 *      live store is never swept; a session installing into it right now must keep
 *      its hardlink targets.
 *   2. Its mtime is older than `days` — the same age guard the other cache sweeps
 *      use, so a store still in active use by a resuming session of the prior
 *      runtime (recently touched) survives until it has genuinely gone cold.
 *
 * Unlike the overlay base, a pnpm store is a pure content-addressed cache: dropping
 * it costs only a re-fetch+relink on the next install, never user data. Lazily
 * recreated on the next pnpm session for that runtime.
 */
async function sweepStalePnpmStores(
  stateDir: string,
  liveHash: string | null,
  days: number,
  paceMs: number,
): Promise<number> {
  const cutoffMs = Date.now() - days * 86_400_000;
  const dir = path.join(stateDir, PNPM_STORE_SUBDIR);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0; // No pnpm-store subtree yet — nothing to sweep.
  }

  let removed = 0;
  for (const entry of entries) {
    if (liveHash !== null && entry === liveHash) continue; // live store — never sweep.
    const full = path.join(dir, entry);
    let mtimeMs: number;
    try {
      // lstat, not stat: a symlink named like a store hash must never be followed.
      const st = await fs.lstat(full);
      if (!st.isDirectory()) continue;
      mtimeMs = st.mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs >= cutoffMs) continue; // recently touched — keep (a resume may use it).
    try {
      await sleep(paceMs);
      await fs.rm(full, { recursive: true, force: true });
      removed += 1;
      console.log(`[disk-janitor] removed stale pnpm store ${full}`);
    } catch (err) {
      console.warn(`[disk-janitor] failed to remove ${full}:`, getMessage(err));
    }
  }
  return removed;
}

/**
 * GraphQL response shapes for the orphan-branch sweep — declared at module
 * scope so the types stay close to the queries that produce them.
 *
 * The sweep issues two separate paginated queries (see
 * `fetchShipitBranchesWithPrStates`):
 *   1. `refs(refPrefix: "refs/heads/shipit/")` — what branches exist.
 *   2. `pullRequests(states: [OPEN, MERGED])` — head ref → PR states map.
 *
 * We deliberately do NOT use `Ref.associatedPullRequests` here: it returned
 * empty for every branch on ShipIt's own repo whose PR was merged (181 of
 * 186 affected), while the PR-side `pullRequests(headRefName:)` query
 * returned them correctly. See the diagnostic write-up referenced from
 * docs/. The PR-side enumeration is the only reliable join.
 */
interface ShipitRefsConnection {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: { name: string }[];
}

interface ShipitRefsQueryResult {
  data?: {
    repository?: {
      refs?: ShipitRefsConnection | null;
    } | null;
  };
}

interface ShipitPrStatesConnection {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: { state: "OPEN" | "MERGED"; headRefName: string }[];
}

interface ShipitPrStatesQueryResult {
  data?: {
    repository?: {
      pullRequests?: ShipitPrStatesConnection | null;
    } | null;
  };
}

/**
 * Sweep orphaned `shipit/*` remote branches whose PR is merged.
 *
 * This is the safety-net for branches that leaked before
 * `markMergedAndPruneExcess` (services/session.ts) started deleting head
 * branches at merge-detection time. Per-merge deletion handles the
 * going-forward path; this sweep clears the historical backlog and any
 * future merges that slipped through (e.g. the orchestrator was down when
 * the merge happened, the catch-up probe ran while auth was disconnected).
 *
 * Safety criteria — a branch is only deleted when ALL hold:
 *   1. Name starts with `shipit/` (we created it).
 *   2. At least one associated PR is in state `MERGED`. Bare branches with
 *      no PRs are left alone (might be local-only work the user pushed).
 *      Branches whose only PRs are `CLOSED` (closed without merging) are
 *      also left alone — that closure could mean "user changed their mind
 *      but wants the commits."
 *   3. No associated PR is in state `OPEN` (some workflows reuse a head
 *      branch across multiple PRs; if any are still open, hands off).
 *   4. No non-archived ShipIt session points at this branch. Archived
 *      sessions are excluded because `unarchiveSession` generates a fresh
 *      branch name, so the old one is genuinely orphaned.
 *
 * Skip conditions:
 *   - GitHub auth not present → no-op (returns 0).
 *   - Repo URL doesn't parse as github.com (SSH/HTTPS/owner/repo
 *     extraction) → skip that repo.
 *   - GraphQL query fails or returns no data → skip that repo.
 *   - Bare cache directory missing → skip that repo's deletions (push
 *     --delete needs a local git context; the cache is the cheapest one
 *     we have. A REST DELETE fallback is possible but unnecessary in
 *     practice — repos without caches were probably already cleaned up
 *     by `sweepOrphanedCaches`).
 *
 * The remote URL on the bare cache is refreshed to embed the current
 * token before pushing, mirroring `unarchiveSession` — without this, a
 * rotated PAT would 401 the push.
 */
async function sweepOrphanMergedBranches(
  sessionManager: SessionManager,
  repoStore: RepoStore,
  githubAuthManager: GitHubAuthManager,
  createRepoGit: (dir: string) => RepoGit,
  getBareCacheDir: (repoUrl: string) => string,
  paceMs: number,
): Promise<number> {
  if (!githubAuthManager.authenticated) return 0;

  // Build a remote → live-branches index from every non-evicted session.
  // We deliberately use `listAll()` (minus evicted), NOT `list()`: a merged
  // session that has dropped out of the sidebar's per-repo top-N view is still
  // `hot` on disk and the user can resume it, so its branch must be preserved.
  // Only `evicted` sessions' branches are treated as orphaned, because
  // `unarchiveSession` generates a fresh branch on restore (see
  // services/session.ts), so the old branch is truly abandoned.
  const liveByRemote = new Map<string, Set<string>>();
  for (const s of sessionManager.listAll()) {
    if (s.diskTier === "evicted") continue;
    if (!s.remoteUrl || !s.branch) continue;
    let set = liveByRemote.get(s.remoteUrl);
    if (!set) {
      set = new Set();
      liveByRemote.set(s.remoteUrl, set);
    }
    set.add(s.branch);
  }

  let removed = 0;
  for (const repo of repoStore.list()) {
    const parsed = parseGitHubRemote(repo.url);
    if (!parsed) continue;

    let branches: { shortName: string; states: string[] }[];
    try {
      branches = await fetchShipitBranchesWithPrStates(
        githubAuthManager, parsed.owner, parsed.repo,
      );
    } catch (err) {
      console.warn(
        `[disk-janitor] branch query failed for ${parsed.owner}/${parsed.repo}:`,
        getMessage(err),
      );
      continue;
    }

    const liveBranches = liveByRemote.get(repo.url) ?? new Set<string>();
    const cacheDir = getBareCacheDir(repo.url);

    // Lazy: only stat the cache dir / construct RepoGit / refresh creds
    // when we actually have a deletion to perform for this repo.
    let cacheGit: RepoGit | null = null;
    const ensureCacheGit = async (): Promise<RepoGit | null> => {
      if (cacheGit) return cacheGit;
      try {
        await fs.stat(cacheDir);
      } catch {
        return null; // No bare cache for this repo — skip.
      }
      const gitInstance = createRepoGit(cacheDir);
      try {
        // Normalize the cache's origin URL to the plain form. Credentials
        // come from the global git credential helper, not the URL.
        // Overwriting here also strips any token a previous code path baked
        // into the URL, so push errors below cannot leak the token.
        await gitInstance.setRemoteUrl(repo.url);
      } catch (err) {
        console.warn(
          `[disk-janitor] failed to normalize remote URL for ${cacheDir}:`,
          getMessage(err),
        );
        return null;
      }
      cacheGit = gitInstance;
      return cacheGit;
    };

    // Pre-compute the eligible set so we can log a complete summary per
    // repo even when we end up performing 0 deletions. Without this, a repo
    // whose N branches are all somehow ineligible looks identical in the
    // logs to a repo with no branches at all — which is exactly how the
    // `Ref.associatedPullRequests` bug went undetected for so long (every
    // branch reported empty states, so the sweep silently did nothing for
    // the entire historical backlog).
    const eligible = branches.filter((b) => {
      const fullName = `shipit/${b.shortName}`;
      if (liveBranches.has(fullName)) return false;
      const hasMerged = b.states.includes("MERGED");
      const hasOpen = b.states.includes("OPEN");
      return hasMerged && !hasOpen;
    });

    if (branches.length > 0) {
      console.log(
        `[disk-janitor] ${parsed.owner}/${parsed.repo}: ${branches.length} branches, ${eligible.length} eligible`,
      );
    }

    for (const branch of eligible) {
      const fullName = `shipit/${branch.shortName}`;

      const git = await ensureCacheGit();
      if (!git) break; // No cache → skip remaining branches for this repo.

      try {
        await sleep(paceMs);
        await git.deleteBranch(fullName);
        removed += 1;
      } catch (err) {
        console.warn(
          `[disk-janitor] failed to delete orphan branch ${fullName}:`,
          getMessage(err),
        );
      }
    }
  }

  if (removed > 0) {
    console.log(`[disk-janitor] removed ${removed} orphan merged-PR branch(es)`);
  }
  return removed;
}

/**
 * Fetch all `refs/heads/shipit/*` branches for a repo together with the
 * states of their associated pull requests.
 *
 * Implementation: two paginated GraphQL passes joined client-side.
 *
 *   Pass 1 enumerates `refs(refPrefix: "refs/heads/shipit/")` — this
 *   gives us the canonical list of `shipit/*` branches that exist on the
 *   remote. The refPrefix filter keeps the query cost bounded by branch
 *   count, not by total repo refs.
 *
 *   Pass 2 enumerates `pullRequests(states: [OPEN, MERGED])` and groups
 *   them by `headRefName`. CLOSED-without-merge PRs are intentionally
 *   not queried — the sweep's policy treats them identically to "no PR"
 *   (both buckets are preserved), so dropping them shrinks the response
 *   without changing any outcome.
 *
 * Why not `Ref.associatedPullRequests`? Because empirically it returns
 * empty for branches whose PR is merged: observed on ShipIt's own repo,
 * 181 merged PRs had a `Ref → PR` back-link of zero results, while the
 * `PR → headRefName` forward query returned them correctly. That broke
 * the sweep silently for the entire historical backlog. The PR-side
 * enumeration is the only reliable join.
 *
 * Pages are hard-capped at 50 per pass (≤5,000 PRs / branches), which
 * comfortably exceeds anything a real ShipIt user could accumulate. If a
 * branch's PR happens to fall past the cap it lands in our map as
 * "absent" → the sweep treats it as no-PR → preserved, which is the safe
 * direction to err.
 */
async function fetchShipitBranchesWithPrStates(
  githubAuthManager: GitHubAuthManager,
  owner: string,
  repo: string,
): Promise<{ shortName: string; states: string[] }[]> {
  // Pass 1: enumerate shipit/* refs. `refs.nodes[].name` is the suffix
  // after `refPrefix` (i.e. `foo`, not `shipit/foo`).
  const refsQuery = /* GraphQL */ `
    query ShipitBranchRefs($owner: String!, $repo: String!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        refs(refPrefix: "refs/heads/shipit/", first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { name }
        }
      }
    }
  `;

  const branchNames: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const result: ShipitRefsQueryResult | null = await githubAuthManager.graphqlQuery(
      refsQuery, { owner, repo, cursor },
    );
    const refs: ShipitRefsConnection | null | undefined = result?.data?.repository?.refs;
    if (!refs) break;
    for (const node of refs.nodes) branchNames.push(node.name);
    if (!refs.pageInfo.hasNextPage) break;
    cursor = refs.pageInfo.endCursor;
    if (!cursor) break;
  }

  // Pass 2: enumerate OPEN+MERGED PRs and group their states by
  // `headRefName`. The headRefName is the full branch name without the
  // `refs/heads/` prefix (e.g. `shipit/foo`).
  const prQuery = /* GraphQL */ `
    query ShipitBranchPRs($owner: String!, $repo: String!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequests(states: [OPEN, MERGED], first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { state headRefName }
        }
      }
    }
  `;

  const prStatesByHead = new Map<string, Set<string>>();
  cursor = null;
  for (let page = 0; page < 50; page += 1) {
    const result: ShipitPrStatesQueryResult | null = await githubAuthManager.graphqlQuery(
      prQuery, { owner, repo, cursor },
    );
    const prs: ShipitPrStatesConnection | null | undefined = result?.data?.repository?.pullRequests;
    if (!prs) break;
    for (const node of prs.nodes) {
      let set = prStatesByHead.get(node.headRefName);
      if (!set) {
        set = new Set();
        prStatesByHead.set(node.headRefName, set);
      }
      set.add(node.state);
    }
    if (!prs.pageInfo.hasNextPage) break;
    cursor = prs.pageInfo.endCursor;
    if (!cursor) break;
  }

  // Join: branch's relative name → full `shipit/<name>` → states from map.
  // Branches with no matching PR get an empty states array, which the
  // sweep correctly treats as "no MERGED" → preserve.
  return branchNames.map((shortName) => ({
    shortName,
    states: Array.from(prStatesByHead.get(`shipit/${shortName}`) ?? []),
  }));
}

/**
 * Drop every Docker volume labeled `shipit-session=<sessionId>`. Used by
 * `archiveSession` as a fallback for the case where the runner was already
 * disposed (e.g. by idle eviction) before archive ran — in that scenario
 * the `removeVolumesOnDispose` flag never fires because there's no
 * `disposed` handler left to read it, and the named volumes leak until
 * the next orchestrator startup. Calling this unconditionally from
 * archive is a fast no-op when the flag-driven path already cleaned up.
 *
 * `runDocker` is injectable for tests. The real implementation uses the
 * same `defaultRunDocker` spawner the startup janitor uses.
 */
export async function pruneSessionVolumes(
  sessionId: string,
  opts: { runDocker?: (args: string[]) => Promise<string> } = {},
): Promise<void> {
  const runDocker = opts.runDocker ?? defaultRunDocker;
  try {
    await runDocker([
      "volume", "prune", "-f", "--filter", `label=shipit-session=${sessionId}`,
    ]);
  } catch (err) {
    console.warn(
      `[disk-janitor] pruneSessionVolumes(${sessionId}) failed:`,
      getMessage(err),
    );
  }
}
