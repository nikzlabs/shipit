/**
 * docs/161 Part 2 — steady-state disk-tier escalation ladder (hot → light →
 * evicted).
 *
 * Distinct from the startup janitor (`startup-janitor.ts`): the failure-recovery
 * sweeps there run once at boot, but the disk-tier ladder is the one disk task
 * that accumulates STEADILY (idle node_modules piling up), so it does NOT live in
 * `runDiskJanitor`. It's invoked async after each session start (the primary
 * steady-state reclaim), at orchestrator boot, AND on a low-frequency periodic
 * timer (issue #1049 — `DISK_ESCALATION_INTERVAL_MS`, wired in `index.ts`),
 * because session-start kicks alone create a self-heal feedback trap (a full disk
 * fails new starts → the kick never fires → nothing reclaims).
 */

import fs from "node:fs/promises";
import type { SessionManager } from "./sessions.js";
import type { SessionInfo } from "../shared/types.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { ServiceManager } from "./service-manager.js";
import type { GitManager } from "../shared/git.js";
import { IDLE_LIGHT_MS, IDLE_EVICT_MS, IDLE_EVICT_MERGED_MS } from "./sessions.js";
import { getMessage, sleep } from "./disk-utils.js";

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
  /**
   * Throttle: milliseconds to pause between each AGE-BASED tier descent so the
   * steady-state reclaim of the idle node_modules tail doesn't hammer the
   * Docker daemon a concurrent agent start needs. Deliberately NOT applied to
   * the disk-pressure LRU descent (`applyDiskPressure`) — that path only fires
   * when the box is critically low and new starts are already failing, so there
   * fast is correct. Defaults to `0` (no pause) so unit tests stay fast;
   * production wires it via `DISK_ESCALATION_PACE_MS` in `index.ts`.
   */
  paceMs?: number;
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
  // docs/110 — a pinned (persistent) session is never auto-reclaimed. This is the
  // single chokepoint for BOTH the age-based descent and the disk-pressure LRU
  // descent, so this one guard makes a pin immune to all automatic tier demotion;
  // its workspace is never dropped or wiped. (Explicit user archive still evicts,
  // but archive clears the pin first — see SessionManager.archive.)
  if (s.pinnedAt) return false;
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
  const paceMs = deps.paceMs ?? 0;

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
      // Pace only when we're about to actually act — skipped candidates
      // (wrong tier / not idle enough) cost nothing and shouldn't drip-delay
      // the scan. The disk-pressure descent below is intentionally un-paced.
      if (tier === "light" && age >= evictThreshold) {
        await sleep(paceMs);
        const outcome = await reclaimToEvicted(s, deps);
        if (outcome === "evicted") result.toEvicted += 1;
        else if (outcome === "blocked-by-push") result.evictBlockedByPush += 1;
      } else if (tier === "hot" && age >= idleLight) {
        await sleep(paceMs);
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
