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

export function restoreReservedPreviews(deps: KeepPreviewRuntimeDeps): string[] {
  const activated: string[] = [];
  for (const session of deps.sessionManager.listAll()) {
    if (!session.keepPreviewRunning) continue;
    // A surviving container still needs a runner to restore process-local preview routing.
    if (deps.runnerRegistry.get(session.id)) continue;
    if (activateReservedPreview(session, deps)) activated.push(session.id);
  }
  return activated;
}

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
