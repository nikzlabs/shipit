import type { LogSource, SessionInfo } from "../shared/types.js";
import type { SessionContainerManager } from "./session-container.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { SessionManager } from "./sessions.js";

export const KEEP_PREVIEW_RESTART_DELAYS_MS = [1_000, 10_000, 30_000] as const;

interface KeepPreviewRuntimeDeps {
  sessionManager: SessionManager;
  runnerRegistry: SessionRunnerRegistry;
  containerManager: SessionContainerManager;
  defaultAgentId: SessionInfo["agentId"];
  broadcastLog?: (sessionId: string, source: LogSource, text: string) => void;
  delaysMs?: readonly number[];
  setTimer?: typeof setTimeout;
}

/** Activate through the canonical runner factory; runner creation owns Compose startup. */
export function activateReservedPreview(
  session: SessionInfo,
  deps: Pick<KeepPreviewRuntimeDeps, "runnerRegistry" | "defaultAgentId">,
): boolean {
  if (!session.workspaceDir || session.archived || session.userArchived || session.warm) return false;
  deps.runnerRegistry.getOrCreate(
    session.id,
    session.workspaceDir,
    session.agentId ?? deps.defaultAgentId ?? "claude",
  );
  return true;
}

/**
 * Restore durable reservations that have no live runtime after startup.
 *
 * **The test is "no runner", not "no running container"** (docs/290). A
 * reservation promises the preview stays up across an orchestrator restart, and
 * a preview is only up when it is REACHABLE: `preview-proxy.ts` resolves a
 * service port through `serviceManagers`, which is process-local and empty at
 * boot. So a reserved session whose agent container happened to survive the
 * restart used to be skipped here — leaving it with no runner, no manager, an
 * unroutable Compose stack, and the reservation quietly broken until someone
 * opened the session. `compose-stack-reaper.ts` exempts reserved sessions on the
 * strength of this function, so that exemption was resting on a guarantee the
 * code did not provide (review finding).
 *
 * Keying on the runner is also what keeps the old guard's intent. `getOrCreate`
 * ADOPTS a rediscovered running container rather than creating a second one —
 * it is the same call `reattachInFlightTurns` makes to adopt a live turn — so
 * nothing is duplicated; what it adds is the runner and the ServiceManager that
 * make the preview routable again.
 */
export function restoreReservedPreviews(deps: KeepPreviewRuntimeDeps): string[] {
  const activated: string[] = [];
  for (const session of deps.sessionManager.listAll()) {
    if (!session.keepPreviewRunning) continue;
    // Already live — the boot adoption sweep took its turn, or a viewer beat us
    // to it. Nothing to restore.
    if (deps.runnerRegistry.get(session.id)) continue;
    if (activateReservedPreview(session, deps)) activated.push(session.id);
  }
  return activated;
}

/**
 * Bounded crash recovery for reserved agent containers. Each attempt reuses the
 * normal runner factory. Successful `container_started` events cancel the
 * remaining budget; exhaustion leaves the durable flag set and logs a terminal
 * error for the existing Logs/session surfaces.
 */
export function createKeepPreviewRestartSupervisor(deps: KeepPreviewRuntimeDeps): {
  handleUnexpectedExit: (sessionId: string) => void;
  dispose: () => void;
} {
  const timers = new Map<string, Set<ReturnType<typeof setTimeout>>>();
  const schedule = deps.setTimer ?? setTimeout;
  const delays = deps.delaysMs ?? KEEP_PREVIEW_RESTART_DELAYS_MS;

  const clear = (sessionId: string): void => {
    for (const timer of timers.get(sessionId) ?? []) clearTimeout(timer);
    timers.delete(sessionId);
  };
  const onStarted = (sessionId: string): void => clear(sessionId);
  deps.containerManager.on("container_started", onStarted);

  return {
    handleUnexpectedExit(sessionId) {
      clear(sessionId);
      const session = deps.sessionManager.get(sessionId);
      if (!session?.keepPreviewRunning) return;
      const pending = new Set<ReturnType<typeof setTimeout>>();
      timers.set(sessionId, pending);
      delays.forEach((delayMs, index) => {
        const timer = schedule(() => {
          pending.delete(timer);
          const latest = deps.sessionManager.get(sessionId);
          if (!latest?.keepPreviewRunning) {
            clear(sessionId);
            return;
          }
          if (deps.containerManager.get(sessionId)?.status === "running") {
            clear(sessionId);
            return;
          }
          activateReservedPreview(latest, deps);
          deps.broadcastLog?.(
            sessionId,
            "server",
            `Restarting reserved preview runtime (attempt ${index + 1}/${delays.length}).`,
          );
          if (index === delays.length - 1) {
            deps.broadcastLog?.(
              sessionId,
              "server",
              "Reserved preview runtime could not be restored after bounded retries. The reservation remains enabled; check session and service logs.",
            );
            timers.delete(sessionId);
          }
        }, delayMs);
        pending.add(timer);
      });
    },
    dispose() {
      for (const sessionId of timers.keys()) clear(sessionId);
      deps.containerManager.off("container_started", onStarted);
    },
  };
}
