import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SessionManager } from "./sessions.js";
import type { SessionInfo } from "../shared/types.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { ServiceManager } from "./service-manager.js";
import type { GitManager } from "../shared/git.js";
import type { PersistedMessage } from "./chat-history.js";
import { DEFAULT_DISK_LADDER, holdsActiveReservation, type DiskLadderThresholds } from "./sessions.js";
import {
  getMessage,
  sleep,
  reclaimRegenerableSessionDirs,
  reclaimBlockedSessionCaches,
} from "./disk-utils.js";
import { emitNoticePostTurn } from "./chat-card-persistence.js";
import { formatEvictBlockedNotice, type EvictBlockReason } from "./services/evict-blocked-notice.js";
import { autoCommitAllowed } from "./services/auto-commit-gate.js";
import { ensureCheckoutDurable, pathState } from "./checkout-durability.js";

export interface TierEscalationDeps {
  sessionManager: SessionManager;
  runnerRegistry: SessionRunnerRegistry;
  serviceManagers: Map<string, ServiceManager>;
  containerManager?: { destroy(sessionId: string): Promise<void> } | null;
  pruneVolumes?: (sessionId: string) => Promise<void>;
  // Must also stop stacks inherited from a previous orchestrator, absent from the maps.
  stopComposeStack?: (sessionId: string) => Promise<unknown>;
  createGitManager?: (dir: string) => GitManager;
  ladder?: DiskLadderThresholds;
  chatHistory?: { append(sessionId: string, message: PersistedMessage): unknown };
  notifiedEvictBlocked?: Set<string>;
  evictStuckLog?: Map<string, string>;
  diskFreeLow?: number;
  diskFreeHigh?: number;
  getFreeDiskBytes?: () => Promise<number | null>;
  now?: () => number;
  // Pace age-based cleanup only; disk pressure requires immediate reclamation.
  paceMs?: number;
}

export interface TierEscalationResult {
  toLight: number;
  toEvicted: number;
  evictBlockedByPush: number;
  evictBlockedByDirty: number;
}

function diskIdleAgeMs(s: SessionInfo, now: number): number {
  const used = Date.parse(s.lastUsedAt);
  const viewed = s.lastViewedAt ? Date.parse(s.lastViewedAt) : NaN;
  const latest = Math.max(
    Number.isFinite(used) ? used : 0,
    Number.isFinite(viewed) ? viewed : 0,
  );
  return now - latest;
}

function canAutoDescend(s: SessionInfo, runnerRegistry: SessionRunnerRegistry): boolean {
  if (s.pinnedAt) return false;
  if (holdsActiveReservation(s)) return false;
  const runner = runnerRegistry.get(s.id);
  if (runner?.agentBusy) return false;
  if (runner && runner.viewerCount > 0) return false;
  return true;
}

async function reclaimToLight(
  session: SessionInfo,
  deps: TierEscalationDeps,
): Promise<boolean> {
  const { sessionManager, runnerRegistry, pruneVolumes } = deps;
  const runner = runnerRegistry.get(session.id);
  const runnerWasAlive = runner !== undefined;

  if (runner && "removeVolumesOnDispose" in runner) {
    (runner as { removeVolumesOnDispose: boolean }).removeVolumesOnDispose = true;
  }
  runnerRegistry.dispose(session.id);
  // Work can start after the eligibility check. Respect a refused disposal.
  if (runner && !runner.disposed) {
    // Do not leave volume removal armed for a later ordinary idle disposal.
    if ("removeVolumesOnDispose" in runner) {
      (runner as { removeVolumesOnDispose: boolean }).removeVolumesOnDispose = false;
    }
    console.log(
      `[disk-janitor] light: skipping container destroy for ${session.id}`
      + " — runner declined disposal (still holds live work)",
    );
    return false;
  }

  if (deps.containerManager) {
    try {
      await deps.containerManager.destroy(session.id);
    } catch (err) {
      console.warn(`[disk-janitor] light: container destroy failed for ${session.id}:`, getMessage(err));
    }
  }

  if (!runnerWasAlive) {
    const mgr = deps.serviceManagers.get(session.id);
    if (mgr) {
      try { await mgr.stop({ removeVolumes: true }); } catch { /* best-effort */ }
      // Activation adopts existing managers without starting them again.
      deps.serviceManagers.delete(session.id);
    }
    if (deps.stopComposeStack) {
      try { await deps.stopComposeStack(session.id); }
      catch (err) { console.warn(`[disk-janitor] light: compose teardown failed for ${session.id}:`, getMessage(err)); }
    }
    if (pruneVolumes) {
      try { await pruneVolumes(session.id); } catch { /* best-effort */ }
    }
  }

  sessionManager.setDiskTier(session.id, "light");
  console.log(`[disk-janitor] ${session.id}: hot → light (dropped deps, kept checkout)`);
  return true;
}

// Keep uncommittable work outside git, including rescue refs, which could expose secrets.
async function blockedEvict<T extends "blocked-by-push" | "blocked-by-dirty">(
  session: SessionInfo,
  deps: TierEscalationDeps,
  outcome: T,
  reason?: EvictBlockReason,
): Promise<T> {
  clearStuck(session, deps);
  if (reason) {
    console.warn(
      `[disk-janitor] evict blocked for ${session.id} — the checkout can't be made durable `
      + `(${reason.kind}), keeping it at light`,
    );
  }
  // Git/network work may have outlasted the session's idle state.
  const fresh = deps.sessionManager.get(session.id);
  const stillIdle = fresh !== undefined && canAutoDescend(fresh, deps.runnerRegistry);
  if (session.workspaceDir && stillIdle) {
    const r = await reclaimBlockedSessionCaches(session.workspaceDir);
    if (r.message) {
      console.warn(`[disk-janitor] evict blocked: cache reclaim failed for ${session.id}:`, r.message);
    }
    if (r.removed.length > 0) {
      console.log(`[disk-janitor] ${session.id}: blocked evict — reclaimed dep caches, kept checkout`);
    }
  }
  const notified = deps.notifiedEvictBlocked;
  if (reason && deps.chatHistory && !notified?.has(session.id)) {
    try {
      const runner = deps.runnerRegistry.get(session.id);
      emitNoticePostTurn(
        (m) => runner?.emitMessage(m),
        deps.chatHistory,
        session.id,
        formatEvictBlockedNotice(reason),
        "warn",
      );
      // Mark only after persistence succeeds, so a failed notice can be retried.
      notified?.add(session.id);
    } catch (err) {
      console.warn(`[disk-janitor] evict blocked: notice failed for ${session.id}:`, getMessage(err));
    }
  }
  return outcome;
}

async function isEmptyDir(dir: string): Promise<boolean> {
  const entries = await readdir(dir).catch(() => null);
  return entries !== null && entries.length === 0;
}

function warnStuck(
  session: SessionInfo,
  deps: TierEscalationDeps,
  signature: string,
  message: string,
): void {
  const log = deps.evictStuckLog;
  if (log?.get(session.id) === signature) return;
  log?.set(session.id, signature);
  console.warn(message);
}

function clearStuck(session: SessionInfo, deps: TierEscalationDeps): void {
  deps.evictStuckLog?.delete(session.id);
}

async function reclaimToEvicted(
  session: SessionInfo,
  deps: TierEscalationDeps,
): Promise<"evicted" | "blocked-by-push" | "blocked-by-dirty" | "skipped"> {
  const { sessionManager, createGitManager } = deps;

  // Missing/empty workspaces need restore; loose files without a repository must survive.
  const wsDir = session.workspaceDir;
  const workspaceMissing = wsDir !== undefined && (await pathState(wsDir)) === "absent";
  const repoMissing = wsDir !== undefined && !workspaceMissing
    && (await pathState(join(wsDir, ".git"))) === "absent";
  const emptyRemnant = repoMissing && await isEmptyDir(wsDir);
  const nothingToProtect = workspaceMissing || emptyRemnant;
  if (nothingToProtect && !session.remoteUrl) {
    warnStuck(
      session, deps,
      `no-remote:${workspaceMissing ? "missing" : "empty-remnant"}`,
      `[disk-janitor] evict skipped for ${session.id} — workspace `
      + `${workspaceMissing ? "missing" : "is an empty non-repository directory"} and no remote to `
      + "restore from (this cannot change on its own; further passes stay quiet)",
    );
    return "skipped";
  }

  // Ops/sandbox sessions cannot be restored from metadata, even with a checkout origin.
  if (!autoCommitAllowed(session)) {
    console.warn(
      `[disk-janitor] evict refused for ${session.id} — kind=${session.kind} sessions are never `
      + "evicted: restore re-clones from session metadata they don't have, so the wipe would be "
      + "unrecoverable; keeping the checkout at light",
    );
    return await blockedEvict(session, deps, "blocked-by-push");
  }

  if (repoMissing && !emptyRemnant) {
    return await blockedEvict(session, deps, "blocked-by-push", { kind: "no-repository" });
  }

  if (createGitManager && session.workspaceDir && !nothingToProtect) {
    try {
      const git = createGitManager(session.workspaceDir);

      const durability = await ensureCheckoutDurable(
        git, "Auto-commit before disk eviction (docs/161)",
      );
      if (durability.state === "blocked-by-dirty") {
        return await blockedEvict(session, deps, "blocked-by-dirty", durability.reason);
      }
      if (durability.state === "blocked-by-push") {
        if (durability.cause === "detached-head") {
          console.warn(
            `[disk-janitor] evict blocked for ${session.id} — HEAD is detached, so its commits `
            + "belong to no branch that could be pushed; keeping at light",
          );
        } else {
          console.warn(
            `[disk-janitor] evict blocked for ${session.id} — the branch tip is not on origin `
            + "and the push failed (offline / no auth / no remote), keeping at light:",
            durability.message,
          );
        }
        return await blockedEvict(session, deps, "blocked-by-push");
      }
    } catch (err) {
      const message = getMessage(err);
      warnStuck(
        session, deps, `git-check:${message}`,
        `[disk-janitor] evict skipped for ${session.id} — git check failed`
        + ` (repeats of this same failure stay quiet): ${message}`,
      );
      return "skipped";
    }
    clearStuck(session, deps);
  }

  const fresh = sessionManager.get(session.id);
  if (!fresh || !canAutoDescend(fresh, deps.runnerRegistry)) {
    console.warn(`[disk-janitor] evict skipped for ${session.id} — became active during remediation`);
    return "skipped";
  }

  deps.runnerRegistry.dispose(session.id);
  const evictRunner = deps.runnerRegistry.get(session.id);
  if (evictRunner && !evictRunner.disposed) {
    console.warn(
      `[disk-janitor] evict skipped for ${session.id} — runner declined disposal (still holds live work)`,
    );
    return "skipped";
  }
  if (deps.containerManager) {
    try {
      await deps.containerManager.destroy(session.id);
    } catch (err) {
      console.warn(`[disk-janitor] evict: container destroy failed for ${session.id}:`, getMessage(err));
    }
  }

  // Stop inherited Compose stacks too, before deleting their mounted workspace.
  const evictMgr = deps.serviceManagers.get(session.id);
  if (evictMgr) {
    try { await evictMgr.stop(); } catch { /* best-effort */ }
    deps.serviceManagers.delete(session.id);
  }
  if (deps.stopComposeStack) {
    try {
      await deps.stopComposeStack(session.id);
    } catch (err) {
      const message = getMessage(err);
      warnStuck(
        session, deps, `compose-teardown:${message}`,
        `[disk-janitor] evict skipped for ${session.id} — its compose stack could not be `
        + "stopped, and wiping a workspace a service still has mounted is never correct "
        + `(repeats of this same failure stay quiet): ${message}`,
      );
      return "skipped";
    }
  }

  // Teardown awaits can allow a new activation; recheck immediately before deletion.
  const stillIdle = sessionManager.get(session.id);
  if (!stillIdle || !canAutoDescend(stillIdle, deps.runnerRegistry)) {
    console.warn(`[disk-janitor] evict skipped for ${session.id} — became active during teardown`);
    return "skipped";
  }

  if (session.workspaceDir) {
    const { failed } = await reclaimRegenerableSessionDirs(session.workspaceDir);
    for (const f of failed) {
      console.warn(`[disk-janitor] evict: rm failed for ${session.id} (${f.dir}):`, f.message);
    }
  }

  sessionManager.setDiskTier(session.id, "evicted");
  clearStuck(session, deps);
  console.log(`[disk-janitor] ${session.id}: light → evicted (workspace + overlay wiped)`);
  return "evicted";
}

export async function escalateDiskTiers(
  deps: TierEscalationDeps,
  excludeSessionId?: string,
): Promise<TierEscalationResult> {
  const result: TierEscalationResult = {
    toLight: 0, toEvicted: 0, evictBlockedByPush: 0, evictBlockedByDirty: 0,
  };
  const now = (deps.now ?? Date.now)();
  const ladder = deps.ladder ?? DEFAULT_DISK_LADDER;
  const paceMs = deps.paceMs ?? 0;

  const candidates = deps.sessionManager.listAll().filter(
    (s) => s.id !== excludeSessionId && s.diskTier !== "evicted",
  );

  for (const s of candidates) {
    if (!canAutoDescend(s, deps.runnerRegistry)) continue;
    const age = diskIdleAgeMs(s, now);
    const tier = s.diskTier ?? "hot";
    const evictThreshold = s.mergedAt ? ladder.evictMergedAfterMs : ladder.evictUnmergedAfterMs;
    try {
      if (tier === "light" && age >= evictThreshold) {
        await sleep(paceMs);
        const outcome = await reclaimToEvicted(s, deps);
        if (outcome === "evicted") result.toEvicted += 1;
        else if (outcome === "blocked-by-push") result.evictBlockedByPush += 1;
        else if (outcome === "blocked-by-dirty") result.evictBlockedByDirty += 1;
      } else if (tier === "hot" && age >= ladder.lightAfterMs) {
        await sleep(paceMs);
        if (await reclaimToLight(s, deps)) result.toLight += 1;
      }
    } catch (err) {
      console.warn(`[disk-janitor] tier escalation failed for ${s.id}:`, getMessage(err));
    }
  }

  await applyDiskPressure(deps, now, excludeSessionId, result);

  const stuck = deps.evictStuckLog;
  if (stuck && stuck.size > 0) {
    const stillLight = new Set(
      deps.sessionManager.listAll().filter((s) => (s.diskTier ?? "hot") === "light").map((s) => s.id),
    );
    for (const id of [...stuck.keys()]) {
      if (!stillLight.has(id)) stuck.delete(id);
    }
  }

  if (result.toLight || result.toEvicted || result.evictBlockedByPush || result.evictBlockedByDirty) {
    console.log(
      `[disk-janitor] tier escalation: hot→light=${result.toLight} `
      + `light→evicted=${result.toEvicted} evict-blocked-push=${result.evictBlockedByPush} `
      + `evict-blocked-dirty=${result.evictBlockedByDirty}`,
    );
  }
  return result;
}

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

  const lru = (sids: SessionInfo[]) =>
    sids.slice().sort((a, b) => diskIdleAgeMs(b, now) - diskIdleAgeMs(a, now));

  // Reclaim dependencies before checkouts, regardless of idle age.
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
      else if (outcome === "blocked-by-dirty") result.evictBlockedByDirty += 1;
    } catch (err) {
      console.warn(`[disk-janitor] pressure evict failed for ${s.id}:`, getMessage(err));
    }
    free = await getFreeDiskBytes();
  }
}
