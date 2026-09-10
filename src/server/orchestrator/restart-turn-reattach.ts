import type { SessionContainerManager } from "./session-container.js";
import type { SessionRunnerInterface, SessionRunnerRegistry } from "./session-runner.js";
import type { SessionManager } from "./sessions.js";
import { holdsActiveReservation } from "./sessions.js";
import type { AgentId, WorkerAgentStatus } from "../shared/types.js";
import { workerGet } from "./worker-http.js";
import { getErrorMessage } from "./validation.js";
import { getContainerFreshness } from "./container-freshness.js";
import { sleep } from "./disk-utils.js";

export interface ReattachDeps {
  containerManager: SessionContainerManager | null;
  runnerRegistry: SessionRunnerRegistry;
  sessionManager: SessionManager;
  defaultAgentId: AgentId;
  orchestratorBuildId?: string;
  confirmDelayMs?: number;
}

const PROBE_TIMEOUT_MS = 3000;

// running describes the resident process, which can be idle between turns.
function staleIdleHoldReason(status: WorkerAgentStatus): string | null {
  // Legacy workers without turnActive have unknown liveness.
  if (status.turnActive !== false) {
    return "the worker predates docs/240 and does not report turn liveness";
  }
  if (status.selfWakeActive === true) return "a self-woken turn is in flight";
  const tasks = status.backgroundTaskCount ?? 0;
  if (tasks > 0) return `${tasks} background task(s) still outstanding`;
  if (status.installRunning === true) return "agent.install is still running";
  // Shell presence is the only signal; it may contain a running build.
  if (status.terminalActive === true) return "a terminal session is running in the container";
  return null;
}

// A CLI can clear its task list just before self-waking; confirm after that gap.
const RECLAIM_CONFIRM_DELAY_MS = 1000;

// No runner does not imply idle when the worker probe failed.
export const unprobedAfterRestart = new Set<string>();

// Preserve Compose stacks serving work that this sweep kept without creating a runner.
export const liveWorkAfterRestart = new Set<string>();

// Boot-only adoption and stale-worker reclamation; Compose stacks are reaped separately.
export async function reattachInFlightTurns(deps: ReattachDeps): Promise<number> {
  const {
    containerManager, runnerRegistry, sessionManager, defaultAgentId,
    orchestratorBuildId = process.env.SHIPIT_BUILD_ID,
    confirmDelayMs = RECLAIM_CONFIRM_DELAY_MS,
  } = deps;
  if (!containerManager) return 0;

  const candidates = containerManager.getAll().filter((c) => {
    if (c.status !== "running") return false;
    if (containerManager.isStandby(c.sessionId)) return false;
    const session = sessionManager.get(c.sessionId);
    return !!session?.workspaceDir && !session.archived;
  });
  if (candidates.length === 0) return 0;

  const results = await Promise.all(
    candidates.map(async (c) => {
      let status: WorkerAgentStatus;
      try {
        status = await workerGet(c.workerUrl, "/agent/status", { timeoutMs: PROBE_TIMEOUT_MS }) as WorkerAgentStatus;
      } catch (err) {
        console.warn(
          `[turn-reattach] /agent/status probe failed for ${c.sessionId}: ${getErrorMessage(err)}`,
        );
        unprobedAfterRestart.add(c.sessionId);
        return false;
      }
      const session = sessionManager.get(c.sessionId);
      if (!session?.workspaceDir) return false;
      if (status.turnActive !== true) {
        // Record live work before freshness filtering: current workers also need their stacks.
        const liveWork = staleIdleHoldReason(status);
        if (liveWork) liveWorkAfterRestart.add(c.sessionId);
        const freshness = getContainerFreshness(c.workerBuildId, orchestratorBuildId);
        if (freshness.state !== "stale") return false;
        const hold = holdsActiveReservation(session) ? "the session holds an always-on preview reservation" : liveWork;
        if (hold) {
          console.log(`[worker-reclaim] Keeping stale container for ${c.sessionId} — ${hold}`);
          return false;
        }
        try {
          await sleep(confirmDelayMs);
          let confirm: WorkerAgentStatus;
          try {
            confirm = await workerGet(
              c.workerUrl, "/agent/status", { timeoutMs: PROBE_TIMEOUT_MS },
            ) as WorkerAgentStatus;
          } catch (err) {
            liveWorkAfterRestart.add(c.sessionId);
            console.log(
              `[worker-reclaim] Keeping stale container for ${c.sessionId}`
              + ` — its confirming probe failed: ${getErrorMessage(err)}`,
            );
            return false;
          }
          if (confirm.turnActive === true) {
            liveWorkAfterRestart.add(c.sessionId);
            console.log(
              `[worker-reclaim] Keeping stale container for ${c.sessionId}`
              + ` — a turn started between the two probes`,
            );
            return false;
          }
          const confirmedHold = staleIdleHoldReason(confirm);
          if (confirmedHold) {
            liveWorkAfterRestart.add(c.sessionId);
            console.log(
              `[worker-reclaim] Keeping stale container for ${c.sessionId} — ${confirmedHold}`
              + ` (reported on the confirming probe)`,
            );
            return false;
          }
          // A runner can appear during the delay; its refusal to dispose must prevent destruction.
          const existingRunner = runnerRegistry.get(c.sessionId);
          if (existingRunner) {
            if (existingRunner.agentBusy || existingRunner.viewerCount > 0) return false;
            const preserving = existingRunner as SessionRunnerInterface
              & { preserveComposeOnDispose: boolean };
            preserving.preserveComposeOnDispose = true;
            runnerRegistry.dispose(c.sessionId);
            if (!existingRunner.disposed) {
              // Do not suppress Compose teardown on a later, unrelated disposal.
              preserving.preserveComposeOnDispose = false;
              console.log(
                `[worker-reclaim] Keeping stale container for ${c.sessionId}`
                + ` — its runner declined disposal (still holds live work)`,
              );
              return false;
            }
          }
          // Full destroy also removes session volumes and sidecars; reclaim only the agent container.
          await containerManager.destroyAgentContainer(c.sessionId);
          liveWorkAfterRestart.delete(c.sessionId);
          console.log(
            `[worker-reclaim] Destroyed stale idle agent container for ${c.sessionId}`
            + ` (no viewer at boot; a fresh one starts on the current image when the session is opened)`,
          );
        } catch (err) {
          console.error(
            `[worker-reclaim] failed to reclaim stale idle container for ${c.sessionId}: ${getErrorMessage(err)}`,
          );
        }
        return false;
      }

      if (runnerRegistry.get(c.sessionId)) return false;
      try {
        const runner = runnerRegistry.getOrCreate(
          c.sessionId,
          session.workspaceDir,
          session.agentId ?? defaultAgentId,
        );
        return (await runner.resumeInFlightTurn?.()) ?? false;
      } catch (err) {
        liveWorkAfterRestart.add(c.sessionId);
        console.error(
          `[turn-reattach] failed to reattach ${c.sessionId}: ${getErrorMessage(err)}`,
        );
        return false;
      }
    }),
  );

  const adopted = results.filter(Boolean).length;
  if (adopted > 0) {
    console.log(`[turn-reattach] Reattached ${adopted} in-flight agent turn(s) from the previous run`);
  }
  return adopted;
}
