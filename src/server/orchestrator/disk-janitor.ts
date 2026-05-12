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
 * failed, orphan caches only exist if repo removal didn't cascade. None
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
 */

import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import type { SessionManager } from "./sessions.js";
import type { RepoStore } from "./repo-store.js";
import { repoUrlToHash } from "./git-utils.js";

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
   * Shell-out hook for docker prune commands. Overridable for tests so we
   * never touch a real Docker daemon from unit tests. Resolves with the
   * combined stdout/stderr of the command (the "Total reclaimed space"
   * line is parsed from this).
   */
  runDocker?: (args: string[]) => Promise<string>;
}

export interface DiskJanitorResult {
  /** Session-compose volumes removed (cross-referenced against active sessions). */
  orphanVolumesRemoved: number;
  workspacesRemoved: number;
  cachesRemoved: number;
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
    workspacesRemoved: 0,
    cachesRemoved: 0,
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

  console.log(
    `[disk-janitor] reclaimed orphan-volumes=${result.orphanVolumesRemoved} `
    + `workspaces=${result.workspacesRemoved} `
    + `caches=${result.cachesRemoved}`,
  );
  return result;
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
