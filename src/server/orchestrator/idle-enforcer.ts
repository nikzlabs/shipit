import type { SessionContainerManager } from "./session-container.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { CredentialStore } from "./credential-store.js";
import type { DockerMemoryStats, WsLogEntry } from "../shared/types.js";
import { isUnderEvictionPressure } from "./memory-pressure.js";
import { getErrorMessage } from "./validation.js";

// ---- Idle container enforcement ----

/** Dependencies for idle container enforcement. */
export interface IdleEnforcementDeps {
  containerManager: SessionContainerManager | null;
  credentialStore: CredentialStore;
  runnerRegistry: SessionRunnerRegistry;
  /**
   * Returns the most recent Docker memory snapshot, or `null` when stats
   * aren't available yet. When usage crosses the eviction threshold the
   * enforcer becomes aggressive: bypasses the 60s grace period and drops
   * effective `maxIdleContainers` to 0 so any session without a viewer or
   * running agent is reaped immediately. This is the only release valve
   * when many sessions are concurrently active and the host is running
   * out of headroom — without it, idle eviction won't fire because every
   * session is technically "in use."
   *
   * Optional: when omitted, the enforcer falls back to the legacy
   * non-pressure-aware behavior. Tests that don't care about pressure
   * should leave this off.
   */
  getMemoryStats?: () => DockerMemoryStats | null;
  /**
   * Optional broadcast hook. When provided, the enforcer fires a
   * `session_status` SSE event with `reason: "idle-disposed"` (or
   * `"memory-pressure"`) before tearing down the runner. The orchestrator
   * uses this to surface "Session paused after N minutes idle. Send a
   * message to resume." in the client — without it, the user sees
   * `containerState: missing` in the health strip with no explanation.
   * See docs/124-session-rescue-and-diagnostics §1.6.
   */
  sseBroadcast?: (event: string, data: unknown) => void;
  /**
   * Optional per-session log hook. Mirrors the `session_status` SSE event
   * into the per-session Logs ring buffer so a viewer that reconnects
   * later still sees why their container went away.
   */
  broadcastLog?: (sessionId: string, source: WsLogEntry["source"], text: string) => void;
}

/**
 * Grace period after a viewer detaches before the runner becomes eligible for
 * idle cleanup. Protects against transient WebSocket disconnects (network
 * blips, page reloads, session switches) — a runner whose last viewer just
 * detached is kept around for this window so a quick reconnect doesn't pay
 * the cost of a fresh container start.
 */
export const IDLE_GRACE_PERIOD_MS = 60_000;

/**
 * Create the `enforceIdleContainerLimit` function. When more containers are
 * idle than the configured limit, stop the oldest excess containers and
 * dispose their runners.
 *
 * Important invariants:
 *  - Never disposes a runner whose agent is currently running (`runner.running`).
 *  - Never disposes a runner that lost its last viewer within the grace
 *    period — protects against transient WebSocket disconnects.
 *  - Runner disposal is TOCTOU-safe: state is re-checked at dispose time, and
 *    `runner.dispose()` itself refuses to run while the agent is active.
 *
 * This function MUST NOT be called synchronously from a WebSocket close
 * handler. WebSocket lifecycle is independent from runner/container
 * lifecycle. Schedule via the periodic timer instead.
 */
export function createIdleEnforcer(
  enforceDeps: IdleEnforcementDeps,
): () => void {
  const {
    containerManager, credentialStore, runnerRegistry, getMemoryStats,
    sseBroadcast, broadcastLog,
  } = enforceDeps;

  return () => {
    if (!containerManager) return;

    // When the host is under eviction pressure, ignore the grace period
    // and drop effective maxIdle to 0. Running agents and attached viewers
    // are still off-limits — those are real work, not idle slack.
    const underPressure = getMemoryStats ? isUnderEvictionPressure(getMemoryStats()) : false;
    const maxIdle = underPressure ? 0 : credentialStore.getMaxIdleContainers();
    const now = Date.now();
    const idleSessionIds: string[] = [];

    for (const sc of containerManager.getAll()) {
      if (containerManager.isStandby(sc.sessionId)) continue;
      const runner = runnerRegistry.get(sc.sessionId);
      if (!runner) {
        // Container exists without a runner — orphaned. Eligible for cleanup.
        idleSessionIds.push(sc.sessionId);
        continue;
      }
      if (runner.running) continue;
      if (runner.viewerCount > 0) continue;
      // Skip runners whose last viewer detach was within the grace period —
      // a transient disconnect must never lead to disposal. Under memory
      // pressure we override this: a closed tab is a closed tab, and the
      // host needs the bytes back now.
      if (
        !underPressure
        && runner.lastViewerDetachAt > 0
        && now - runner.lastViewerDetachAt < IDLE_GRACE_PERIOD_MS
      ) {
        continue;
      }
      idleSessionIds.push(sc.sessionId);
    }

    if (idleSessionIds.length > maxIdle) {
      // Map insertion order = oldest first; slice from the front to keep the newest.
      const excess = idleSessionIds.slice(0, idleSessionIds.length - maxIdle);
      for (const sid of excess) {
        // TOCTOU re-check: between the scan and now, the runner may have
        // become active (new viewer attached, agent started). Dispose only
        // if it is still safe to do so. `runner.dispose()` also enforces
        // this at the runner level (defense in depth).
        const runner = runnerRegistry.get(sid);
        if (runner && (runner.running || runner.viewerCount > 0)) {
          continue;
        }
        const reason = underPressure ? "memory-pressure" : "idle-disposed";
        const idleMs = runner && runner.lastViewerDetachAt > 0
          ? Math.max(0, now - runner.lastViewerDetachAt)
          : undefined;
        console.log(
          `[idle-cleanup] Stopping idle container for session ${sid}`
          + ` (reason=${reason}${idleMs !== undefined ? ` idleMs=${idleMs}` : ""})`,
        );
        // Surface the disposal to the user before tearing down. Without
        // this, the user comes back to a tab that just shows
        // `containerState: missing` with no explanation. The SSE event is
        // delivered via the global event channel; the runner-attached
        // emitMessage path is unavailable because we're about to dispose
        // the runner. Per-session Logs ring also gets a copy so a future
        // reconnect / diagnostics dump still has the record.
        // See docs/124-session-rescue-and-diagnostics §1.6.
        if (sseBroadcast) {
          sseBroadcast("session_status", {
            type: "session_status",
            sessionId: sid,
            running: false,
            queueLength: runner?.queueLength ?? 0,
            reason,
            ...(idleMs !== undefined ? { idleMs } : {}),
          });
        }
        if (broadcastLog) {
          const idleLabel = idleMs !== undefined ? `${Math.round(idleMs / 1000)}s` : "idle period";
          const human = reason === "memory-pressure"
            ? `Session container reaped (memory pressure).`
            : `Session container paused after ${idleLabel}. Send a message to resume.`;
          broadcastLog(sid, "server", human);
        }
        containerManager.destroy(sid).catch((err: unknown) => {
          const errMsg = getErrorMessage(err);
          console.error(`[idle-cleanup] Failed to destroy container ${sid}:`, errMsg);
          // The runner is already disposed by the line below — its
          // emitMessage path is gone — so the only durable way to
          // surface this is the per-session log ring. Without it, the
          // user sees a session that disappeared with no log entry
          // explaining the destroy failed.
          if (broadcastLog) {
            broadcastLog(
              sid,
              "server",
              `Failed to destroy idle container: ${errMsg}. Container may still be running on the host.`,
            );
          }
        });
        runnerRegistry.dispose(sid);
      }
    }
  };
}
