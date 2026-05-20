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
 *
 * Why startup-only (no timer): every item above is recovering from a
 * failure earlier in the lifecycle — orphan volumes only exist if archive
 * teardown crashed, orphan workspaces only exist if archive's fs.rm
 * failed, orphan caches only exist if repo removal didn't cascade, orphan
 * networks only exist if the disposal/teardown path didn't run. None
 * of them accumulate steadily, so running periodically would mostly
 * burn cycles doing nothing. Startup is the natural "we just came back
 * from possibly-unclean shutdown — clean up after the previous run"
 * moment. ShipIt's prod box auto-deploys on push (so startup is frequent
 * in practice); long-uptime self-hosted boxes get the sweep on their
 * next restart, which is good enough for safety-net work.
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
  /** Remote `shipit/*` branches whose PR is merged and no live session uses them. */
  orphanBranchesRemoved: number;
  /** Per-session credential subtrees removed (archived or untracked sessions). */
  credentialDirsRemoved: number;
}

const DEFAULT_CACHE_DAYS = 30;

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

  const livePrefixes = new Set(
    sessionManager.list().map((s) => s.id.slice(0, 12).toLowerCase()),
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

  const livePrefixes = new Set(
    sessionManager.list().map((s) => s.id.slice(0, 12).toLowerCase()),
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
 * GraphQL response shape for the orphan-branch sweep — declared at module
 * scope so the type stays close to the query that produces it.
 */
interface ShipitBranchRefsConnection {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: {
    name: string;
    associatedPullRequests: {
      nodes: { state: "OPEN" | "CLOSED" | "MERGED" }[];
    };
  }[];
}

interface ShipitBranchesQueryResult {
  data?: {
    repository?: {
      refs?: ShipitBranchRefsConnection | null;
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

  // Build a remote → live-branches index from non-archived sessions.
  // Archived sessions' branches are NOT preserved: unarchive generates a
  // fresh branch (see `unarchiveSession` in services/session.ts), so the
  // old branch is truly orphaned.
  const liveByRemote = new Map<string, Set<string>>();
  for (const s of sessionManager.list()) {
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

    for (const branch of branches) {
      const fullName = `shipit/${branch.shortName}`;
      if (liveBranches.has(fullName)) continue;
      const hasMerged = branch.states.includes("MERGED");
      const hasOpen = branch.states.includes("OPEN");
      if (!hasMerged || hasOpen) continue;

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
 * Fetch all `refs/heads/shipit/*` branches for a repo, paginating through
 * the GraphQL response. Each result includes the state of associated PRs
 * so the caller can apply the safety criteria.
 *
 * The query name-prefix filter (`refPrefix: "refs/heads/shipit/"`) means
 * non-shipit branches never enter the response at all — bounding the
 * query cost regardless of repo size.
 */
async function fetchShipitBranchesWithPrStates(
  githubAuthManager: GitHubAuthManager,
  owner: string,
  repo: string,
): Promise<{ shortName: string; states: string[] }[]> {
  const query = /* GraphQL */ `
    query ShipitBranches($owner: String!, $repo: String!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        refs(refPrefix: "refs/heads/shipit/", first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            name
            associatedPullRequests(first: 10) {
              nodes { state }
            }
          }
        }
      }
    }
  `;

  const out: { shortName: string; states: string[] }[] = [];
  let cursor: string | null = null;
  // Hard cap on pages so a misconfigured repo with thousands of stale
  // shipit branches can't loop forever.
  for (let page = 0; page < 50; page += 1) {
    const result: ShipitBranchesQueryResult | null = await githubAuthManager.graphqlQuery(
      query, { owner, repo, cursor },
    );
    const refs: ShipitBranchRefsConnection | null | undefined = result?.data?.repository?.refs;
    if (!refs) break;
    for (const node of refs.nodes) {
      out.push({
        shortName: node.name,
        states: node.associatedPullRequests.nodes.map((p) => p.state),
      });
    }
    if (!refs.pageInfo.hasNextPage) break;
    cursor = refs.pageInfo.endCursor;
    if (!cursor) break;
  }
  return out;
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
