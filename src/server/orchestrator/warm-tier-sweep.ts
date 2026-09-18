import type { RepoStore } from "./repo-store.js";
import type { SessionManager } from "./sessions.js";
import type { SessionContainerManager } from "./session-container.js";
import type { DockerMemoryStats } from "../shared/types.js";
import type { EnsureStandbyOptions } from "./warm-pool-manager.js";
import { isUnderEvictionPressure } from "./memory-pressure.js";
import { getErrorMessage } from "./validation.js";
import path from "node:path";

export const WARM_SWEEP_INTERVAL_MS = 5 * 60_000;

// Standby creation continues after the warm promise resolves.
export const WARM_REPAIR_GRACE_MS = 5 * 60_000;

export function startWarmTierSweep(
  deps: WarmTierSweepDeps,
  opts: { intervalMs?: number } = {},
): NodeJS.Timeout {
  const runPass = createWarmTierSweep(deps);
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void runPass()
      .catch((err: unknown) => { console.error("[warm-sweep] pass failed:", err); })
      .finally(() => { inFlight = false; });
  }, opts.intervalMs ?? WARM_SWEEP_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

export interface WarmTierSweepDeps {
  repoStore: RepoStore;
  sessionManager: SessionManager;
  containerManager: SessionContainerManager | null;
  warmSessionForRepo: (repoUrl: string) => Promise<void>;
  ensureStandbyForWarmSession: (opts: EnsureStandbyOptions) => Promise<void>;
  waitForWarmSession?: (repoUrl: string) => Promise<void> | undefined;
  // Remove the manager as well as its containers so preview repair can rebuild it.
  stopPreview?: (sessionId: string) => void;
  repairPreview?: (opts: { sessionId: string; workspaceDir: string; repoUrl: string }) => Promise<void>;
  getMemoryStats?: () => DockerMemoryStats | null;
}

export function createWarmTierSweep(deps: WarmTierSweepDeps): () => Promise<void> {
  const {
    repoStore, sessionManager, containerManager,
    warmSessionForRepo, ensureStandbyForWarmSession, waitForWarmSession, stopPreview, repairPreview,
    getMemoryStats,
  } = deps;

  // Probe Docker; the tracking map can miss standby exits. Undefined is not proof of death.
  async function standbyIsUp(sessionId: string): Promise<boolean | undefined> {
    if (!containerManager) return undefined;
    const tracked = containerManager.get(sessionId);
    if (!tracked) return false;
    if (tracked.status === "starting") return true;
    return containerManager.isTrackedContainerRunning(sessionId);
  }

  return async () => {
    if (!containerManager) return;
    // Avoid rebuilding containers the memory enforcer will immediately discard.
    if (isUnderEvictionPressure(getMemoryStats?.() ?? null)) return;

    for (const repo of repoStore.list()) {
      if (repo.status !== "ready") continue;
      if (waitForWarmSession?.(repo.url)) continue;

      try {
        const warmId = repo.warmSessionId;
        if (!warmId) {
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
        if (up !== false) {
          // A healthy standby may have lost its preview under memory pressure.
          if (up === true && repoStore.get(repo.url)?.warmSessionId === warmId) {
            await repairPreview?.({
              sessionId: warmId,
              workspaceDir: session.workspaceDir,
              repoUrl: repo.url,
            });
          }
          continue;
        }

        // A claim during the Docker probe transfers ownership to the user.
        if (repoStore.get(repo.url)?.warmSessionId !== warmId) continue;

        console.log(
          `[warm-sweep] ${repo.url}: standby for warm session ${warmId} is not running — rebuilding it`,
        );
        stopPreview?.(warmId);
        await containerManager.destroy(warmId).catch(() => undefined);
        await ensureStandbyForWarmSession({
          sessionId: warmId,
          sessionDir: path.dirname(session.workspaceDir),
          workspaceDir: session.workspaceDir,
          repoUrl: repo.url,
          stillWanted: () => repoStore.get(repo.url)?.warmSessionId === warmId,
        });
      } catch (err) {
        console.error(`[warm-sweep] ${repo.url}: repair failed:`, getErrorMessage(err));
      }
    }
  };
}
