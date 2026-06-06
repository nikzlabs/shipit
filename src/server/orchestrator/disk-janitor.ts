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
 *   - **Archived session workspaces** older than
 *     `DISK_JANITOR_ARCHIVED_WORKSPACE_DAYS` days. Safety net for archives
 *     where `fs.rm` didn't run — `archiveSession` already drops the
 *     workspace at archive time on a healthy host, so this normally finds
 *     nothing. Chat history, usage, and session metadata are preserved;
 *     `unarchiveSession` re-clones from the bare cache.
 *   - **Orphan `repo-cache/<hash>` and `dep-cache/<hash>` directories**
 *     whose repo URL has no `repos` row or whose `last_used_at` is older
 *     than `DISK_JANITOR_CACHE_DAYS` (default 30).
 *   - **Stale `dep-cache/<hash>/nm-store/<storeKey>` snapshots** for live
 *     repos whose `<storeKey>` directory mtime is older than
 *     `DISK_JANITOR_NM_STORE_DAYS` (default 14). These materialized
 *     `node_modules` trees accumulate as lockfiles bump; mtime-only
 *     pruning is enough because a spurious miss is one slow install.
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
 * `escalateDiskTiers`, invoked async after each session start (the primary
 * steady-state reclaim), at orchestrator boot, AND on a low-frequency periodic
 * timer (issue #1049 — `DISK_ESCALATION_INTERVAL_MS`, hourly default, wired in
 * `index.ts`). The timer exists specifically because escalation accumulates
 * steadily: session-start kicks alone create a self-heal feedback trap (a full
 * disk fails new starts → the kick never fires → nothing reclaims). The
 * failure-recovery sweeps above deliberately get NO such timer. The startup
 * janitor remains the post-(unclean-)restart safety net for the recovery items.
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
 *   - DISK_JANITOR_ARCHIVED_WORKSPACE_DAYS: when set to a positive number,
 *     archived sessions whose `last_used_at` is older than this many days
 *     have their `workspaceDir` removed. Default `0` (disabled).
 *   - DISK_JANITOR_CACHE_DAYS: age in days at which `repo-cache/<hash>`
 *     and `dep-cache/<hash>` directories whose repo has no `repos` row are
 *     deleted. Default `30`.
 *   - DISK_JANITOR_NM_STORE_DAYS: age in days at which individual
 *     `dep-cache/<hash>/nm-store/<storeKey>` snapshots for tracked repos
 *     are deleted by mtime. Default `14`.
 *   - DISK_JANITOR_ORPHAN_BRANCHES: when `"false"`, disables the
 *     orphan-`shipit/*`-branch sweep. Default enabled (set the env var to
 *     `"false"` to opt out). The sweep no-ops anyway without GitHub auth.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import type { SessionManager } from "./sessions.js";
import type { RepoStore } from "./repo-store.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { RepoGit } from "./repo-git.js";
import type { SessionInfo } from "../shared/types.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { ServiceManager } from "./service-manager.js";
import type { GitManager } from "../shared/git.js";
import { IDLE_LIGHT_MS, IDLE_EVICT_MS, IDLE_EVICT_MERGED_MS } from "./sessions.js";
import { repoUrlToHash, parseGitHubRemote } from "./git-utils.js";
import { sessionCredentialsRoot } from "./session-credentials.js";

export interface DiskJanitorDeps {
  sessionManager: SessionManager;
  repoStore: RepoStore;
  /** Root that holds `repo-cache/<hash>` and `dep-cache/<hash>` subdirs. */
  stateDir: string;
  /** When > 0, sweep archived session workspaces older than this many days. */
  archivedWorkspaceDays?: number;
  /** Age threshold (days) for unreferenced repo/dep cache directories. */
  cacheDays?: number;
  /**
   * docs/148 — age threshold (days) for individual `nm-store/<storeKey>`
   * snapshots under tracked repos. Old materialized `node_modules` trees pile
   * up as lockfiles bump; this prunes them by mtime. Default 14.
   */
  nmStoreDays?: number;
  /**
   * docs/138 — source-of-truth credentials root (e.g. `/credentials`). When
   * provided, the janitor sweeps per-session credential subtrees under
   * `<credentialsDir>/sessions/<id>` whose session is archived or no longer
   * tracked, so provisioned agent credentials don't linger on disk. Omitted in
   * tests / runtimes without container credentials.
   */
  credentialsDir?: string;
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
}

export interface DiskJanitorResult {
  /** Session-compose volumes removed (cross-referenced against active sessions). */
  orphanVolumesRemoved: number;
  /** Session networks removed (cross-referenced against active sessions). */
  orphanNetworksRemoved: number;
  workspacesRemoved: number;
  cachesRemoved: number;
  /** docs/148 — stale `nm-store/<storeKey>` snapshots removed by mtime. */
  nmStoresRemoved: number;
  /** Remote `shipit/*` branches whose PR is merged and no live session uses them. */
  orphanBranchesRemoved: number;
  /** Per-session credential subtrees removed (archived or untracked sessions). */
  credentialDirsRemoved: number;
}

const DEFAULT_CACHE_DAYS = 30;
const DEFAULT_NM_STORE_DAYS = 14;

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
    orphanBranchesRemoved: 0,
    credentialDirsRemoved: 0,
  };
  const runDocker = deps.runDocker ?? defaultRunDocker;

  try {
    result.orphanVolumesRemoved = await sweepOrphanSessionVolumes(
      deps.sessionManager, runDocker,
    );
  } catch (err) {
    console.warn("[disk-janitor] orphan volume sweep failed:", getMessage(err));
  }

  try {
    result.orphanNetworksRemoved = await sweepOrphanSessionNetworks(
      deps.sessionManager, runDocker,
    );
  } catch (err) {
    console.warn("[disk-janitor] orphan network sweep failed:", getMessage(err));
  }

  try {
    result.workspacesRemoved = await sweepArchivedWorkspaces(
      deps.sessionManager, deps.archivedWorkspaceDays ?? 0,
    );
  } catch (err) {
    console.warn("[disk-janitor] archived-workspace sweep failed:", getMessage(err));
  }

  try {
    result.cachesRemoved = await sweepOrphanedCaches(
      deps.stateDir, deps.repoStore, deps.cacheDays ?? DEFAULT_CACHE_DAYS,
    );
  } catch (err) {
    console.warn("[disk-janitor] cache sweep failed:", getMessage(err));
  }

  try {
    result.nmStoresRemoved = await sweepStaleNmStores(
      deps.stateDir, deps.repoStore, deps.nmStoreDays ?? DEFAULT_NM_STORE_DAYS,
    );
  } catch (err) {
    console.warn("[disk-janitor] nm-store sweep failed:", getMessage(err));
  }

  if (deps.credentialsDir) {
    try {
      result.credentialDirsRemoved = await sweepOrphanCredentialDirs(
        deps.sessionManager, deps.credentialsDir,
      );
    } catch (err) {
      console.warn("[disk-janitor] credential-dir sweep failed:", getMessage(err));
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
    + `orphan-branches=${result.orphanBranchesRemoved} `
    + `credential-dirs=${result.credentialDirsRemoved}`,
  );
  return result;
}

/**
 * docs/138 — remove per-session credential subtrees under
 * `<credentialsDir>/sessions/<id>` whose session is archived or no longer
 * tracked in the DB. These hold copies of the pinned agent's credentials
 * (provisioned on first turn); they should not outlive the session.
 *
 * Preserved: dirs for **active, non-archived** sessions — i.e. sessions still
 * in `allIds()` and NOT in `listArchived()`. This keeps warm and idle-evicted
 * sessions intact (their containers may resume) while reaping archived,
 * deleted, and full-reset sessions. An archived session that's later
 * unarchived simply re-provisions on its next first turn / container create.
 *
 * Returns the count of subtrees removed.
 */
async function sweepOrphanCredentialDirs(
  sessionManager: SessionManager,
  credentialsDir: string,
): Promise<number> {
  const root = sessionCredentialsRoot(credentialsDir);
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return 0; // No per-session credentials dir yet — nothing to sweep.
  }

  const tracked = new Set(sessionManager.allIds());
  const archived = new Set(sessionManager.listArchived().map((s) => s.id));

  let removed = 0;
  for (const entry of entries) {
    // Keep dirs for sessions that are still tracked AND not archived.
    if (tracked.has(entry) && !archived.has(entry)) continue;
    const full = path.join(root, entry);
    try {
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
 * Delete `workspaceDir` for archived sessions whose `last_used_at` is
 * older than `days`. Chat history, usage, and session metadata are
 * preserved — `unarchiveSession` re-clones from the bare cache when the
 * user restores the session.
 *
 * In the current product all sessions have a `remoteUrl`, and
 * `archiveSession` already removes the workspace at archive time, so on
 * a healthy host this sweep is a no-op. It exists as a safety net for:
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
): Promise<number> {
  if (days <= 0) return 0;
  const cutoffMs = Date.now() - days * 86_400_000;
  const archived = sessionManager.listArchived();
  let removed = 0;
  for (const session of archived) {
    if (!session.workspaceDir) continue;
    // Defensive: never sweep a session without a remoteUrl — even though
    // the product guarantees every session has one, a stale row from a
    // prior schema or a test fixture could land here, and deleting the
    // workspace would be unrecoverable.
    if (!session.remoteUrl) continue;
    const lastUsedMs = Date.parse(session.lastUsedAt);
    if (!Number.isFinite(lastUsedMs) || lastUsedMs >= cutoffMs) continue;
    try {
      const stat = await fs.stat(session.workspaceDir).catch(() => null);
      if (!stat) continue;
      await fs.rm(session.workspaceDir, { recursive: true, force: true });
      removed += 1;
      console.log(
        `[disk-janitor] removed archived workspace for ${session.id} (${session.workspaceDir})`,
      );
    } catch (err) {
      console.warn(
        `[disk-janitor] failed to remove archived workspace ${session.workspaceDir}:`,
        getMessage(err),
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
 * docs/148 — under each tracked `dep-cache/<repoHash>/nm-store/`, drop
 * `<storeKey>` directories whose mtime is older than `days` so unused
 * materialized `node_modules` snapshots don't pile up. A storeKey
 * automatically becomes "unused" the moment its repo's lockfile bumps —
 * the next install computes a fresh storeKey, and the old one is never
 * touched again until this sweep reclaims it.
 *
 * Mtime-only — we deliberately don't track which sessions reference which
 * storeKey (it would require a manifest the worker writes back to the
 * orchestrator). A spurious miss (the user pinned their lockfile, sat
 * idle 30 days, then rebooted) is one slow `npm install`, the cost of
 * which is bounded by the same install we were trying to skip.
 *
 * Tracked repos only: the parent `sweepOrphanedCaches` already removes
 * the entire `dep-cache/<hash>` when the repo isn't live, so this only
 * needs to handle the "still-tracked repo, stale storeKey" case.
 */
async function sweepStaleNmStores(
  stateDir: string,
  repoStore: RepoStore,
  days: number,
): Promise<number> {
  if (days <= 0) return 0;
  const cutoffMs = Date.now() - days * 86_400_000;
  const liveHashes = new Set(repoStore.list().map((r) => repoUrlToHash(r.url)));

  let removed = 0;
  for (const repoHash of liveHashes) {
    const nmRoot = path.join(stateDir, "dep-cache", repoHash, "nm-store");
    let entries: string[];
    try {
      entries = await fs.readdir(nmRoot);
    } catch {
      continue; // No nm-store for this repo — nothing to do.
    }
    for (const entry of entries) {
      // Skip in-progress populates (`.tmp-...`). They'll either rename
      // into place or be orphaned by a worker crash; orphan temp dirs are
      // tiny and the next populate will overwrite anyway, so we leave them.
      if (entry.startsWith(".tmp-")) continue;
      const full = path.join(nmRoot, entry);
      let mtimeMs: number;
      try {
        const st = await fs.stat(full);
        mtimeMs = st.mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs >= cutoffMs) continue;
      try {
        await fs.rm(full, { recursive: true, force: true });
        removed += 1;
        console.log(`[disk-janitor] removed stale nm-store ${full}`);
      } catch (err) {
        console.warn(`[disk-janitor] failed to remove ${full}:`, getMessage(err));
      }
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

// ---------------------------------------------------------------------------
// docs/161 Part 2 — disk-tier escalation ladder (hot → light → evicted)
// ---------------------------------------------------------------------------

/**
 * docs/161 — dependencies for the disk-tier escalation pass. Distinct from the
 * startup-janitor deps: escalation needs live runner/container/compose state to
 * evaluate guards and execute teardown, plus a git factory to remediate dirty
 * checkouts before the destructive `evicted` rung.
 */
export interface TierEscalationDeps {
  sessionManager: SessionManager;
  runnerRegistry: SessionRunnerRegistry;
  /** Live compose stacks, keyed by session id (same map the WS layer uses). */
  serviceManagers: Map<string, ServiceManager>;
  /** Destroys the agent container so a bind-mounted workspace can be removed. */
  containerManager?: { destroy(sessionId: string): Promise<void> } | null;
  /** Prune named volumes by `shipit-session=<id>` label when no runner is left. */
  pruneVolumes?: (sessionId: string) => Promise<void>;
  /**
   * Git factory bound to a workspace dir. Used at `light → evicted` to
   * auto-commit + push a dirty checkout before wiping it. Omit in tests that
   * don't exercise dirty remediation.
   */
  createGitManager?: (dir: string) => GitManager;
  /** Idle age (ms) before `hot → light`. Defaults to `IDLE_LIGHT_MS`. */
  idleLightMs?: number;
  /** Idle age (ms) before `light → evicted` for UNMERGED sessions. Defaults to `IDLE_EVICT_MS`. */
  idleEvictMs?: number;
  /**
   * docs/161 — idle age (ms) before `light → evicted` for sessions whose PR is
   * MERGED (`mergedAt` set). A merge is a far stronger "done" signal than idle
   * age, and merged checkouts re-fetch fresh on reopen, so they're reclaimed on
   * a much shorter clock than unmerged WIP. Defaults to `IDLE_EVICT_MERGED_MS`.
   */
  idleEvictMergedMs?: number;
  /**
   * Disk-pressure water marks (bytes free). When `getFreeDiskBytes` reports
   * below `diskFreeLow`, the pass escalates LRU-eligible sessions — ignoring the
   * idle thresholds — until free space crosses `diskFreeHigh`. Both must be set
   * (and `getFreeDiskBytes` provided) for the pressure path to engage.
   */
  diskFreeLow?: number;
  diskFreeHigh?: number;
  /** Free-bytes probe (a `statfs`), injectable for tests. */
  getFreeDiskBytes?: () => Promise<number | null>;
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface TierEscalationResult {
  /** Sessions taken `hot → light` (deps dropped, checkout kept). */
  toLight: number;
  /** Sessions taken `light → evicted` (workspace wiped). */
  toEvicted: number;
  /** Eviction skipped because a dirty checkout's push failed (kept at light). */
  evictBlockedByPush: number;
}

/** docs/161 — idle age for the disk ladder: turn activity OR a recent view. */
function diskIdleAgeMs(s: SessionInfo, now: number): number {
  const used = Date.parse(s.lastUsedAt);
  const viewed = s.lastViewedAt ? Date.parse(s.lastViewedAt) : NaN;
  const latest = Math.max(
    Number.isFinite(used) ? used : 0,
    Number.isFinite(viewed) ? viewed : 0,
  );
  // latest === 0 only for a row with no parseable timestamps — treat as ancient.
  return now - latest;
}

/**
 * Guard shared by every automatic descent: never touch a session whose agent is
 * running or that currently has an attached viewer. (`light` additionally keeps
 * the checkout, so it skips the clean-tree guard handled inline at `evicted`.)
 */
function canAutoDescend(s: SessionInfo, runnerRegistry: SessionRunnerRegistry): boolean {
  const runner = runnerRegistry.get(s.id);
  if (runner?.running) return false;
  if (runner && runner.viewerCount > 0) return false;
  return true;
}

/**
 * `hot → light`: stop the container and drop the per-session compose named
 * volumes (node_modules / build caches — the bulk of the disk), while leaving
 * the workspace checkout (incl. uncommitted edits) on disk. Restore is a
 * dependency reinstall, not a re-clone.
 */
async function reclaimToLight(
  session: SessionInfo,
  deps: TierEscalationDeps,
): Promise<boolean> {
  const { sessionManager, runnerRegistry, pruneVolumes } = deps;
  const runner = runnerRegistry.get(session.id);
  const runnerWasAlive = runner !== undefined;

  // Signal the compose disposed-handler to drop named volumes, then dispose.
  // The guard already proved the agent isn't running, so a non-forced dispose
  // is safe and respects the runner-level "never kill a running agent" rule.
  if (runner && "removeVolumesOnDispose" in runner) {
    (runner as { removeVolumesOnDispose: boolean }).removeVolumesOnDispose = true;
  }
  runnerRegistry.dispose(session.id);

  if (deps.containerManager) {
    try {
      await deps.containerManager.destroy(session.id);
    } catch (err) {
      console.warn(`[disk-janitor] light: container destroy failed for ${session.id}:`, getMessage(err));
    }
  }

  // Fallback: if no runner existed, the flag-driven compose-down with
  // `--volumes` never fired (idle eviction already disposed it). Stop any
  // lingering stack with volume removal and prune by label.
  if (!runnerWasAlive) {
    const mgr = deps.serviceManagers.get(session.id);
    if (mgr) {
      try { await mgr.stop({ removeVolumes: true }); } catch { /* best-effort */ }
    }
    if (pruneVolumes) {
      try { await pruneVolumes(session.id); } catch { /* best-effort */ }
    }
  }

  sessionManager.setDiskTier(session.id, "light");
  console.log(`[disk-janitor] ${session.id}: hot → light (dropped deps, kept checkout)`);
  return true;
}

/**
 * `light → evicted`: the destructive rung. Remediates a dirty checkout first
 * (auto-commit + push to origin); if the push fails the session stays at
 * `light` so the local commit survives on disk. On success the workspace is
 * wiped — restore re-clones from the bare cache off fresh `origin/main`.
 */
async function reclaimToEvicted(
  session: SessionInfo,
  deps: TierEscalationDeps,
): Promise<"evicted" | "blocked-by-push" | "skipped"> {
  const { sessionManager, createGitManager } = deps;

  // Clean-tree guard: a `light` session keeps its checkout on disk, and the
  // container is stopped — so we operate git directly on the host checkout.
  if (createGitManager && session.workspaceDir) {
    try {
      const git = createGitManager(session.workspaceDir);
      if (!(await git.isClean())) {
        const { commitHash } = await git.autoCommit(
          "Auto-commit before disk eviction (docs/161)",
        );
        // Durability gate: the commit must reach `origin` (a recoverable
        // state — evicted → hot re-clones from the cache, which is refreshed
        // from origin). "Tip present in the bare cache" is the wrong gate: a
        // fresh push isn't in the cache until its next fetch. If the push
        // fails (offline / no auth), do NOT evict — leave it at light.
        if (commitHash) {
          try {
            await git.push("origin", session.branch);
          } catch (pushErr) {
            console.warn(
              `[disk-janitor] evict blocked for ${session.id} — push failed, keeping at light:`,
              getMessage(pushErr),
            );
            return "blocked-by-push";
          }
        }
      }
    } catch (err) {
      // A git failure here (corrupt checkout, etc.) must not wipe unrecoverable
      // work — bail out and leave the session at light.
      console.warn(`[disk-janitor] evict skipped for ${session.id} — git check failed:`, getMessage(err));
      return "skipped";
    }
  }

  // Tear down container (no runner should exist at light, but be defensive).
  deps.runnerRegistry.dispose(session.id);
  if (deps.containerManager) {
    try {
      await deps.containerManager.destroy(session.id);
    } catch (err) {
      console.warn(`[disk-janitor] evict: container destroy failed for ${session.id}:`, getMessage(err));
    }
  }

  if (session.workspaceDir) {
    try {
      await fs.rm(session.workspaceDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[disk-janitor] evict: workspace rm failed for ${session.id}:`, getMessage(err));
    }
  }

  sessionManager.setDiskTier(session.id, "evicted");
  console.log(`[disk-janitor] ${session.id}: light → evicted (workspace wiped)`);
  return "evicted";
}

/**
 * docs/161 Part 2 — the disk-tier escalation pass. Walks idle sessions and
 * descends the ladder (`hot → light → evicted`) when idle age crosses the
 * thresholds, or — under disk pressure — escalates least-recently-used eligible
 * sessions regardless of age until free space recovers. The `light → evicted`
 * threshold is merge-aware: a session whose PR is merged (`mergedAt` set) is
 * reclaimed on the short `idleEvictMergedMs` clock, while unmerged WIP stays on
 * the gentle `idleEvictMs` clock. Every descent passes
 * `canAutoDescend` (not running, no attached viewer); the destructive `evicted`
 * rung additionally remediates dirty checkouts.
 *
 * Invoked async after each session start (the primary steady-state reclaim,
 * since prod deploys manually so the startup janitor runs rarely) and never on
 * the start critical path; fired once at orchestrator startup as a safety net
 * for the long-idle tail; and re-fired on a low-frequency periodic timer
 * (issue #1049) so reclaim + the disk-pressure check still run when the
 * instance is quiet or wedged (a full disk fails new session starts, which
 * would otherwise stop the only steady-state trigger). Always resolves — never
 * rejects — so callers can fire-and-forget.
 *
 * Excludes the just-started `excludeSessionId` defensively even though its
 * viewer/running guards would already protect it.
 */
export async function escalateDiskTiers(
  deps: TierEscalationDeps,
  excludeSessionId?: string,
): Promise<TierEscalationResult> {
  const result: TierEscalationResult = { toLight: 0, toEvicted: 0, evictBlockedByPush: 0 };
  const now = (deps.now ?? Date.now)();
  const idleLight = deps.idleLightMs ?? IDLE_LIGHT_MS;
  const idleEvict = deps.idleEvictMs ?? IDLE_EVICT_MS;
  const idleEvictMerged = deps.idleEvictMergedMs ?? IDLE_EVICT_MERGED_MS;

  // Candidate set: non-warm sessions still holding disk, minus the one we just
  // started. (`listAll` already excludes warm.)
  const candidates = deps.sessionManager.listAll().filter(
    (s) => s.id !== excludeSessionId && s.diskTier !== "evicted",
  );

  // --- Age-based descent ---
  for (const s of candidates) {
    if (!canAutoDescend(s, deps.runnerRegistry)) continue;
    const age = diskIdleAgeMs(s, now);
    const tier = s.diskTier ?? "hot";
    // Merge-aware threshold: a merged PR ("done") evicts far sooner than
    // unmerged WIP, which stays on the gentle `idleEvict` clock. Idle age is
    // still max(lastUsedAt, lastViewedAt), so a merged session you reopened to
    // look at isn't yanked mid-view.
    const evictThreshold = s.mergedAt ? idleEvictMerged : idleEvict;
    try {
      if (tier === "light" && age >= evictThreshold) {
        const outcome = await reclaimToEvicted(s, deps);
        if (outcome === "evicted") result.toEvicted += 1;
        else if (outcome === "blocked-by-push") result.evictBlockedByPush += 1;
      } else if (tier === "hot" && age >= idleLight) {
        if (await reclaimToLight(s, deps)) result.toLight += 1;
      }
    } catch (err) {
      console.warn(`[disk-janitor] tier escalation failed for ${s.id}:`, getMessage(err));
    }
  }

  // --- Disk-pressure LRU descent ---
  await applyDiskPressure(deps, now, excludeSessionId, result);

  if (result.toLight || result.toEvicted || result.evictBlockedByPush) {
    console.log(
      `[disk-janitor] tier escalation: hot→light=${result.toLight} `
      + `light→evicted=${result.toEvicted} evict-blocked=${result.evictBlockedByPush}`,
    );
  }
  return result;
}

/**
 * Folded into the escalation pass: when free disk drops below `diskFreeLow`,
 * escalate the least-recently-used eligible sessions (`hot → light` first, then
 * `light → evicted`) regardless of idle age until free space crosses
 * `diskFreeHigh`. Guards still apply. No-op unless both water marks and the
 * probe are configured.
 */
async function applyDiskPressure(
  deps: TierEscalationDeps,
  now: number,
  excludeSessionId: string | undefined,
  result: TierEscalationResult,
): Promise<void> {
  const { diskFreeLow, diskFreeHigh, getFreeDiskBytes } = deps;
  if (diskFreeLow === undefined || diskFreeHigh === undefined || !getFreeDiskBytes) return;

  let free = await getFreeDiskBytes();
  if (free === null || free >= diskFreeLow) return;

  // LRU order: oldest idle first. Re-read from the DB so already-escalated
  // sessions reflect their new tier.
  const lru = (sids: SessionInfo[]) =>
    sids.slice().sort((a, b) => diskIdleAgeMs(b, now) - diskIdleAgeMs(a, now));

  // Pass 1: hot → light (cheap, non-destructive) recovers the bulk of disk.
  for (const s of lru(
    deps.sessionManager.listAll().filter(
      (x) => x.id !== excludeSessionId && (x.diskTier ?? "hot") === "hot",
    ),
  )) {
    if (free !== null && free >= diskFreeHigh) break;
    if (!canAutoDescend(s, deps.runnerRegistry)) continue;
    try {
      if (await reclaimToLight(s, deps)) result.toLight += 1;
    } catch (err) {
      console.warn(`[disk-janitor] pressure light failed for ${s.id}:`, getMessage(err));
    }
    free = await getFreeDiskBytes();
  }

  if (free !== null && free >= diskFreeHigh) return;

  // Pass 2: light → evicted (destructive) only if still under the high mark.
  for (const s of lru(
    deps.sessionManager.listAll().filter(
      (x) => x.id !== excludeSessionId && (x.diskTier ?? "hot") === "light",
    ),
  )) {
    if (free !== null && free >= diskFreeHigh) break;
    if (!canAutoDescend(s, deps.runnerRegistry)) continue;
    try {
      const outcome = await reclaimToEvicted(s, deps);
      if (outcome === "evicted") result.toEvicted += 1;
      else if (outcome === "blocked-by-push") result.evictBlockedByPush += 1;
    } catch (err) {
      console.warn(`[disk-janitor] pressure evict failed for ${s.id}:`, getMessage(err));
    }
    free = await getFreeDiskBytes();
  }
}

/**
 * docs/161 — default free-disk probe for the disk-pressure pass. Returns bytes
 * available to an unprivileged user on the filesystem holding `dir`, or null if
 * `statfs` is unavailable / errors (the pressure path then no-ops gracefully).
 */
export async function statfsFreeBytes(dir: string): Promise<number | null> {
  try {
    const st = await fs.statfs(dir);
    return st.bavail * st.bsize;
  } catch {
    return null;
  }
}

/**
 * docs/161 — total size (bytes) of the filesystem holding `dir`, or null if
 * `statfs` is unavailable / errors. Backs the fraction-of-disk pressure
 * watermarks (`DISK_FREE_LOW_PCT` / `DISK_FREE_HIGH_PCT`), which are portable
 * across host disk sizes in a way the absolute `*_BYTES` vars are not.
 */
export async function statfsTotalBytes(dir: string): Promise<number | null> {
  try {
    const st = await fs.statfs(dir);
    return st.blocks * st.bsize;
  } catch {
    return null;
  }
}

/**
 * docs/161 — resolve the effective disk-pressure byte watermarks from the
 * configured inputs. Each watermark is resolved independently:
 *   - an explicit `*Bytes` value always wins (backward compat), otherwise
 *   - a `*Pct` fraction (0..1) is multiplied by the host's total disk size.
 * A watermark stays `undefined` when neither is set (or a `*Pct` is given but
 * `totalBytes` is unknown), which leaves the pressure override disabled — its
 * gate already no-ops unless BOTH watermarks resolve.
 */
export function resolveDiskWatermarks(inputs: {
  lowBytes?: number;
  highBytes?: number;
  lowPct?: number;
  highPct?: number;
  totalBytes: number | null;
}): { diskFreeLow?: number; diskFreeHigh?: number } {
  const resolve = (bytes: number | undefined, pct: number | undefined): number | undefined => {
    if (bytes !== undefined) return bytes;
    if (pct !== undefined && inputs.totalBytes !== null) return pct * inputs.totalBytes;
    return undefined;
  };
  return {
    diskFreeLow: resolve(inputs.lowBytes, inputs.lowPct),
    diskFreeHigh: resolve(inputs.highBytes, inputs.highPct),
  };
}

function getMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Spawn `docker <args>` and collect combined stdout+stderr. */
function defaultRunDocker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    proc.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    proc.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`docker ${args[0]} exited ${code}: ${output.trim()}`));
    });
    proc.on("error", reject);
  });
}
