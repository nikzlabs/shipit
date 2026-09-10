import type { SessionContainerManager } from "./session-container.js";
import type { SessionRunnerRegistry, SessionRunnerInterface } from "./session-runner.js";
import type { DockerMemoryStats } from "../shared/types.js";
import type { LogSource } from "../shared/types.js";
import { bytesOverBudget } from "./memory-pressure.js";
import { getErrorMessage } from "./validation.js";
import type { SessionManager } from "./sessions.js";
import { holdsActiveReservation } from "./sessions.js";

export interface IdleServiceHooks {
  liveSessions: () => string[];
  has: (sessionId: string) => boolean;
  stop: (sessionId: string) => void;
}

export interface IdleEnforcementDeps {
  containerManager: SessionContainerManager | null;
  runnerRegistry: SessionRunnerRegistry;
  sessionManager?: SessionManager;
  getMemoryStats?: () => DockerMemoryStats | null;
  services?: IdleServiceHooks;
  sseBroadcast?: (event: string, data: unknown) => void;
  broadcastLog?: (sessionId: string, source: LogSource, text: string) => void;
}

interface Candidate {
  sessionId: string;
  runner: SessionRunnerInterface | undefined;
  idleSince: number;
}

// Run from memory-pressure or periodic checks, never directly from a WebSocket close.
export function createIdleEnforcer(
  enforceDeps: IdleEnforcementDeps,
): () => void {
  const {
    containerManager, runnerRegistry, sessionManager, getMemoryStats,
    services, sseBroadcast, broadcastLog,
  } = enforceDeps;

  const tier1At = new Map<string, number>();
  // Do not reclaim twice against the same snapshot or memory still being returned.
  let actedOn: DockerMemoryStats | null = null;
  let teardownsInFlight = 0;

  function isReclaimable(sessionId: string, runner: SessionRunnerInterface | undefined): boolean {
    if (holdsActiveReservation(sessionManager?.get(sessionId))) return false;
    if (!runner) return true;
    // agentBusy includes autonomous turns and pending background work.
    if (runner.agentBusy) return false;
    if (runner.viewerCount > 0) return false;
    return true;
  }

  function byReclaimOrder(a: Candidate, b: Candidate): number {
    return a.idleSince - b.idleSince;
  }

  return () => {
    if (!containerManager) return;

    const stats = getMemoryStats?.() ?? null;
    let need = bytesOverBudget(stats);
    if (need <= 0) return;

    if (stats && stats === actedOn) return;
    if (teardownsInFlight > 0) return;

    const now = Date.now();

    const usage = stats?.bySession ?? {};
    let reclaimedSomething = false;
    // Unknown reclaimed bytes require a fresh snapshot before further eviction.
    let shortfallIsStale = false;

    // Reclaim unclaimed standbys, including their pre-started previews, first.
    for (const sc of containerManager.getAll()) {
      if (need <= 0) break;
      if (!containerManager.isStandby(sc.sessionId)) continue;
      const measured = usage[sc.sessionId];
      const hasPreview = !!services?.has(sc.sessionId);
      need -= (measured?.agentBytes ?? 0) + (hasPreview ? measured?.serviceBytes ?? 0 : 0);
      reclaimedSomething = true;
      console.log(
        `[idle-cleanup] Dropping standby container for ${sc.sessionId} (over memory budget`
        + `${hasPreview ? ", including its pre-started preview" : ""})`,
      );
      // Stop the manager's polling before destroying its containers.
      if (hasPreview) services?.stop(sc.sessionId);
      trackTeardown(containerManager.destroy(sc.sessionId), sc.sessionId);
      if (!measured) { shortfallIsStale = true; break; }
    }

    // Stop idle agent containers before stopping any claimed session's preview.
    const tier1: Candidate[] = [];
    for (const sc of containerManager.getAll()) {
      if (containerManager.isStandby(sc.sessionId)) continue;
      const runner = runnerRegistry.get(sc.sessionId);
      if (!isReclaimable(sc.sessionId, runner)) continue;
      tier1.push({ sessionId: sc.sessionId, runner, idleSince: runner?.lastViewerDetachAt ?? 0 });
    }
    tier1.sort(byReclaimOrder);

    for (const c of (shortfallIsStale ? [] : tier1)) {
      if (need <= 0) break;
      const runner = runnerRegistry.get(c.sessionId);
      if (!isReclaimable(c.sessionId, runner)) continue;

      const keepsPreview = !!services?.has(c.sessionId);
      if (keepsPreview && runner) {
        (runner as SessionRunnerInterface & { preserveComposeOnDispose?: boolean })
          .preserveComposeOnDispose = true;
      }

      // Disposal can refuse; destroy only after it accepts.
      runnerRegistry.dispose(c.sessionId);
      if (runner && !runner.disposed) {
        console.log(
          `[idle-cleanup] Skipping container destroy for session ${c.sessionId}`
          + ` — runner declined disposal (still holds live work)`,
        );
        if (keepsPreview && runner) {
          (runner as SessionRunnerInterface & { preserveComposeOnDispose?: boolean })
            .preserveComposeOnDispose = false;
        }
        continue;
      }

      const measured = usage[c.sessionId];
      const freed = measured?.agentBytes ?? 0;
      need -= freed;
      reclaimedSomething = true;
      if (keepsPreview) tier1At.set(c.sessionId, now);
      const idleMs = c.idleSince > 0 ? Math.max(0, now - c.idleSince) : undefined;
      console.log(
        `[idle-cleanup] Stopping agent container for session ${c.sessionId}`
        + ` (over budget, freed≈${Math.round(freed / 1024 / 1024)}MB,`
        + ` preview=${keepsPreview ? "kept" : "none"}`
        + `${idleMs !== undefined ? ` idleMs=${idleMs}` : ""})`,
      );
      announce(c.sessionId, keepsPreview ? "agent-reclaimed" : "memory-pressure", idleMs, runner?.queueLength ?? 0);
      destroyAgentOnly(c.sessionId);
      if (!measured) { shortfallIsStale = true; break; }
    }

    if (need > 0 && !shortfallIsStale && services) {
      const tier2: Candidate[] = [];
      for (const sessionId of services.liveSessions()) {
        // A missing runner alone can mean an active restart, not an idle preview.
        if (!tier1At.has(sessionId)) continue;
        const runner = runnerRegistry.get(sessionId);
        if (!isReclaimable(sessionId, runner)) continue;
        if (runner) { tier1At.delete(sessionId); continue; }
        tier2.push({ sessionId, runner: undefined, idleSince: tier1At.get(sessionId) ?? 0 });
      }
      tier2.sort(byReclaimOrder);

      for (const c of tier2) {
        if (need <= 0) break;
        if (!isReclaimable(c.sessionId, runnerRegistry.get(c.sessionId))) continue;
        const measured = usage[c.sessionId];
        const freed = measured?.serviceBytes ?? 0;
        need -= freed;
        reclaimedSomething = true;
        tier1At.delete(c.sessionId);
        console.log(
          `[idle-cleanup] Stopping preview services for session ${c.sessionId}`
          + ` (still over budget, freed≈${Math.round(freed / 1024 / 1024)}MB)`,
        );
        announce(c.sessionId, "memory-pressure", undefined, 0);
        services.stop(c.sessionId);
        if (!measured) break;
      }
    }

    if (reclaimedSomething) actedOn = stats;
    else {
      console.log(
        `[idle-cleanup] Over memory budget by ≈${Math.round(need / 1024 / 1024)}MB`
        + ` with nothing idle to reclaim — every session is in use`,
      );
    }
  };

  function announce(
    sessionId: string,
    reason: "agent-reclaimed" | "memory-pressure",
    idleMs: number | undefined,
    queueLength: number,
  ): void {
    if (sseBroadcast) {
      sseBroadcast("session_status", {
        type: "session_status",
        sessionId,
        running: false,
        queueLength,
        reason,
        ...(idleMs !== undefined ? { idleMs } : {}),
      });
    }
    if (broadcastLog) {
      const human = reason === "agent-reclaimed"
        ? `Agent container stopped to stay inside ShipIt's memory budget (workspace preserved). `
          + `The preview is still running. Send a message to resume — a fresh container starts automatically.`
        : `Session container and preview services stopped to reclaim memory (workspace preserved). `
          + `Send a message to resume — a fresh container starts automatically.`;
      broadcastLog(sessionId, "server", human);
    }
  }

  // Full destroy also sweeps the Compose resources this tier must preserve.
  function destroyAgentOnly(sessionId: string): void {
    trackTeardown(containerManager?.destroyAgentContainer(sessionId), sessionId);
  }

  function trackTeardown(p: Promise<void> | undefined, sessionId: string): void {
    if (!p) return;
    teardownsInFlight++;
    p.catch((err: unknown) => {
      const errMsg = getErrorMessage(err);
      console.error(`[idle-cleanup] Failed to destroy container ${sessionId}:`, errMsg);
      if (broadcastLog) {
        broadcastLog(
          sessionId,
          "server",
          `Failed to destroy idle container: ${errMsg}. Container may still be running on the host.`,
        );
      }
    }).finally(() => { teardownsInFlight--; });
  }
}
