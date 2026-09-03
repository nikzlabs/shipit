/**
 * Periodic repair of the warm tier (planning#501, docs/288 req 10).
 *
 * Nothing else notices when a standby container dies. The health reconciler
 * walks `runnerRegistry.ids()` and skips standbys explicitly
 * (`app-lifecycle.ts`) — and a standby has no registered runner to walk in the
 * first place, nor a worker event stream to go quiet. The boot sweep checks
 * that the workspace CLONE exists and, when it does, declares the warm session
 * valid. And `warmSessionForRepo` declines to act while the warm session row
 * exists, so nothing can rebuild what died.
 *
 * The result is an absorbing state: a repo whose standby exits — an OOM inside
 * the pre-install, a Docker daemon restart (the agent container carries no
 * `RestartPolicy`), memory-budget reclaim, any external cleanup — keeps a warm
 * session forever, and every later claim silently pays the full cold cost while
 * still reporting a warm hit.
 *
 * This sweep compares state: what the warm tier should hold against what Docker
 * actually has. Deliberately NOT keyed on an event or a transition — a
 * transition is observed once, by whoever was listening, so a repair that
 * missed it never happens. A comparison gives the same answer however the
 * system got there.
 */

import type { RepoStore } from "./repo-store.js";
import type { SessionManager } from "./sessions.js";
import type { SessionContainerManager } from "./session-container.js";
import type { DockerMemoryStats } from "../shared/types.js";
import type { EnsureStandbyOptions } from "./warm-pool-manager.js";
import { isUnderEvictionPressure } from "./memory-pressure.js";
import { getErrorMessage } from "./validation.js";
import path from "node:path";

/** How often the warm tier is compared against reality. */
export const WARM_SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * How long a warm session is left alone before the sweep will judge it.
 *
 * Warming sets `warmSessionId` and then builds the standby fire-and-forget, so
 * a session that was warmed seconds ago legitimately has no container yet. The
 * in-flight warm promise covers most of that window; this covers the rest —
 * the gap between `warmSessionForRepo` resolving and `createStandby` returning,
 * which is a `docker create` + `start` and can run for tens of seconds on a
 * loaded host.
 */
export const WARM_REPAIR_GRACE_MS = 5 * 60_000;

export interface WarmTierSweepDeps {
  repoStore: RepoStore;
  sessionManager: SessionManager;
  containerManager: SessionContainerManager | null;
  /** Full warm path — for a repo with no usable warm session row at all. */
  warmSessionForRepo: (repoUrl: string) => Promise<void>;
  /** Standby-only repair — the row and the clone are fine, the container is not. */
  ensureStandbyForWarmSession: (opts: EnsureStandbyOptions) => Promise<void>;
  /** In-flight warm for this repo, if any: never judge a session mid-build. */
  waitForWarmSession?: (repoUrl: string) => Promise<void> | undefined;
  getMemoryStats?: () => DockerMemoryStats | null;
}

/**
 * Build the sweep. The returned function runs one pass; the caller owns the
 * interval.
 */
export function createWarmTierSweep(deps: WarmTierSweepDeps): () => Promise<void> {
  const {
    repoStore, sessionManager, containerManager,
    warmSessionForRepo, ensureStandbyForWarmSession, waitForWarmSession, getMemoryStats,
  } = deps;

  /**
   * Does this warm session have a container that is actually running?
   *
   * Docker's answer, not the tracking map's. The map is updated from container
   * events and from a health monitor that standbys are outside of, so it is the
   * very thing that can be wrong here — trusting it would make the sweep blind
   * to the failure it exists to catch.
   *
   * `undefined` means Docker could not answer (daemon busy, inspect failed).
   * That is not evidence of death: during a daemon blip every session looks
   * dead at once, and rebuilding them all is worse than waiting 5 minutes.
   */
  async function standbyIsUp(sessionId: string): Promise<boolean | undefined> {
    if (!containerManager) return undefined;
    const tracked = containerManager.get(sessionId);
    if (!tracked) return false;
    // A container mid-create has no answer to give yet, and the runner factory
    // already knows how to wait for one (`app-lifecycle.ts`, the `starting`
    // branch). Leave it alone.
    if (tracked.status === "starting") return true;
    return containerManager.isTrackedContainerRunning(sessionId);
  }

  return async () => {
    if (!containerManager) return;
    // Rebuilding a speculative container while the machine is already at its
    // budget is the one thing the warm pool must never do — the enforcer would
    // drop it again on the next pass, and the two would take turns.
    if (isUnderEvictionPressure(getMemoryStats?.() ?? null)) return;

    for (const repo of repoStore.list()) {
      if (repo.status !== "ready") continue;
      // A warm in flight owns this repo; its own completion is the repair.
      if (waitForWarmSession?.(repo.url)) continue;

      try {
        const warmId = repo.warmSessionId;
        if (!warmId) {
          // No warm session at all. The event-driven paths (boot, repo add,
          // trust, claim re-warm, graduation) each had their chance; this is
          // the backstop for a repo none of them reached.
          await warmSessionForRepo(repo.url);
          continue;
        }

        const session = sessionManager.get(warmId);
        if (!session?.workspaceDir) {
          console.log(`[warm-sweep] ${repo.url}: warm session ${warmId} is gone — re-warming`);
          repoStore.setWarmSessionId(repo.url, undefined);
          await warmSessionForRepo(repo.url);
          continue;
        }

        if (Date.now() - Date.parse(session.createdAt) < WARM_REPAIR_GRACE_MS) continue;

        const up = await standbyIsUp(warmId);
        if (up !== false) continue;

        // Re-read the pointer after the await. A claim clears `warmSessionId`
        // and takes the session for a user who is opening it right now; the
        // Docker probe above is long enough for that to happen underneath us,
        // and destroying their container would turn a warm claim cold at the
        // worst possible moment.
        if (repoStore.get(repo.url)?.warmSessionId !== warmId) continue;

        console.log(
          `[warm-sweep] ${repo.url}: standby for warm session ${warmId} is not running — rebuilding it`,
        );
        // Drop the dead tracking entry (and whatever the missed `die` would
        // have reaped) before building its replacement, or `createStandby`
        // collides with the old container's name.
        await containerManager.destroy(warmId).catch(() => undefined);
        await ensureStandbyForWarmSession({
          sessionId: warmId,
          sessionDir: path.dirname(session.workspaceDir),
          workspaceDir: session.workspaceDir,
          repoUrl: repo.url,
        });
      } catch (err) {
        // One repo's failure must not end the pass — the next repo may be the
        // one the user is about to open.
        console.error(`[warm-sweep] ${repo.url}: repair failed:`, getErrorMessage(err));
      }
    }
  };
}
