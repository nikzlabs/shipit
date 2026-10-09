import type { SessionContainerManager } from "./session-container.js";
import type { SessionRunnerInterface, SessionRunnerRegistry } from "./session-runner.js";
import type { SessionManager } from "./sessions.js";
import type { ChatHistoryManager } from "./chat-history.js";
import { holdsActiveReservation } from "./sessions.js";
import type { AgentId, WorkerAgentStatus } from "../shared/types.js";
import { workerGet, workerPost } from "./worker-http.js";
import { getErrorMessage } from "./validation.js";
import { getContainerFreshness } from "./container-freshness.js";
import { sleep } from "./disk-utils.js";

export interface ReattachDeps {
  containerManager: SessionContainerManager | null;
  runnerRegistry: SessionRunnerRegistry;
  sessionManager: SessionManager;
  defaultAgentId: AgentId;
  chatHistoryManager?: Pick<ChatHistoryManager, "sessionsWithInProgressRows" | "finalizeInheritedInProgress">;
  orchestratorBuildId?: string;
  confirmDelayMs?: number;
  followRetryDelaysMs?: number[];
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

// A legacy worker without turnActive has no turn only when no agent process runs.
export function workerReportsNoTurn(status: WorkerAgentStatus): boolean {
  return status.turnActive === false || (status.turnActive === undefined && !status.running);
}

// A turn's rows stay in progress until the orchestrator sees it end, and the next turn's
// replaceInProgress deletes them, so a turn that ended while no orchestrator listened is finalized.
function finalizeEndedTurnRows(deps: ReattachDeps, ended: ReadonlySet<string> | null): void {
  const { chatHistoryManager } = deps;
  if (!chatHistoryManager) return;
  try {
    const sessionIds = chatHistoryManager.sessionsWithInProgressRows()
      .filter((id) => ended === null || ended.has(id));
    for (const sessionId of sessionIds) chatHistoryManager.finalizeInheritedInProgress(sessionId);
    if (sessionIds.length > 0) {
      console.log(`[turn-reattach] Finalized the saved rows of ${sessionIds.length} turn(s) that ended during the restart`);
    }
  } catch (err) {
    console.error(`[turn-reattach] finalizing ended turn rows failed: ${getErrorMessage(err)}`);
  }
}

/**
 * Whether a session's worker still does work that no runner follows: a turn, background tasks
 * or an install. An open terminal is the user's shell, which Stop cannot end and which does not
 * keep a scheduled run going. A worker that does not answer counts as working.
 */
export async function workerHasLiveWork(
  containerManager: SessionContainerManager | null,
  sessionId: string,
): Promise<boolean> {
  const container = containerManager?.get(sessionId);
  if (container?.status !== "running") return false;
  try {
    const status = await workerGet(container.workerUrl, "/agent/status", { timeoutMs: PROBE_TIMEOUT_MS }) as WorkerAgentStatus;
    return staleIdleHoldReason({ ...status, terminalActive: false }) !== null;
  } catch {
    return true;
  }
}

/**
 * Stop for a session whose worker still works with no runner to interrupt (docs/324-scheduled-sessions
 * req 33): kills the resident agent, which ends its turn and background tasks. Targets the resident by
 * its run token, so a kill that arrives late spares a replacement. False when there is none.
 */
export async function stopWorkerAgent(
  containerManager: SessionContainerManager | null,
  sessionId: string,
): Promise<boolean> {
  const container = containerManager?.get(sessionId);
  if (container?.status !== "running") return false;
  try {
    const status = await workerGet(container.workerUrl, "/agent/status", { timeoutMs: PROBE_TIMEOUT_MS }) as WorkerAgentStatus;
    if (status.runToken === undefined) return false;
    await workerPost(container.workerUrl, "/agent/kill", { runToken: status.runToken }, { timeoutMs: PROBE_TIMEOUT_MS });
    return true;
  } catch (err) {
    console.warn(`[turn-reattach] stopping the worker agent of ${sessionId} failed: ${getErrorMessage(err)}`);
    return false;
  }
}

// The worker reports a turn nothing here follows; the runner's first connect adopts it.
export async function followWorkerTurn(
  deps: Pick<ReattachDeps, "runnerRegistry" | "sessionManager" | "defaultAgentId">,
  sessionId: string,
): Promise<boolean> {
  const session = deps.sessionManager.get(sessionId);
  if (!session?.workspaceDir || session.archived) return false;
  const runner = deps.runnerRegistry.getOrCreate(
    sessionId,
    session.workspaceDir,
    session.agentId ?? deps.defaultAgentId,
  );
  return (await runner.resumeInFlightTurn?.()) ?? false;
}

type FollowDeps = Pick<ReattachDeps, "containerManager" | "runnerRegistry" | "sessionManager" | "defaultAgentId">;

// A worker says its CLI started a turn that nothing follows. The worker's status decides,
// not the caller: a runner starts the session's Compose services, and the agent can call this.
export async function followReportedTurn(deps: FollowDeps, sessionId: string): Promise<boolean> {
  const runner = deps.runnerRegistry.get(sessionId);
  if (runner) {
    const following = (await runner.resumeInFlightTurn?.()) ?? false;
    if (!following) console.warn(`[turn-reattach] not following ${sessionId}: its runner follows no turn`);
    return following;
  }
  const container = deps.containerManager?.get(sessionId);
  if (!container) {
    console.warn(`[turn-reattach] not following ${sessionId}: no container is tracked for it`);
    return false;
  }
  const status = await workerGet(container.workerUrl, "/agent/status", { timeoutMs: PROBE_TIMEOUT_MS }) as WorkerAgentStatus;
  if (status.turnActive !== true) {
    console.warn(`[turn-reattach] not following ${sessionId}: its worker reports turnActive=${String(status.turnActive)}`);
    return false;
  }
  const following = await followWorkerTurn(deps, sessionId);
  if (!following) console.warn(`[turn-reattach] not following ${sessionId}: the runner it got did not adopt the turn`);
  return following;
}

const CONTAINER_CALL_FOLLOW_MS = 15_000;

/**
 * The runner for a call from the session's own container. The call can come from a turn that
 * nothing here follows after a restart, and the worker's status decides whether it gets one
 * (planning#665). The wait is bounded: a stream that is slow to open must not hold the call.
 */
export async function runnerForContainerCall(
  deps: Omit<FollowDeps, "containerManager"> & { containerManager?: SessionContainerManager | null },
  sessionId: string,
): Promise<SessionRunnerInterface | undefined> {
  const runner = deps.runnerRegistry.get(sessionId);
  const containerManager = deps.containerManager;
  if (runner ? !runner.waitingForWorkerStatus : !containerManager) return runner;
  const follow = (runner
    ? runner.resumeInFlightTurn?.()
    : followReportedTurn({ ...deps, containerManager: containerManager ?? null }, sessionId)
  )?.catch((err: unknown) => {
    console.warn(`[turn-reattach] following ${sessionId} for a container call failed: ${getErrorMessage(err)}`);
  });
  await Promise.race([
    follow,
    new Promise((r) => { setTimeout(r, CONTAINER_CALL_FOLLOW_MS).unref(); }),
  ]);
  return deps.runnerRegistry.get(sessionId);
}

const FOLLOW_RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 90_000];

// Nothing else asks a worker the sweep could not probe about a turn in flight: it has no runner.
async function followLater(deps: ReattachDeps, sessionId: string): Promise<void> {
  for (const delayMs of deps.followRetryDelaysMs ?? FOLLOW_RETRY_DELAYS_MS) {
    await new Promise((r) => { setTimeout(r, delayMs).unref(); });
    try {
      await followReportedTurn(deps, sessionId);
      return;
    } catch (err) {
      console.warn(`[turn-reattach] probe of ${sessionId} failed again: ${getErrorMessage(err)}`);
    }
  }
  console.warn(`[turn-reattach] gave up probing ${sessionId}; a turn in flight there is followed at its next container call`);
}

// Boot-only adoption and stale-worker reclamation; Compose stacks are reaped separately.
export async function reattachInFlightTurns(deps: ReattachDeps): Promise<number> {
  // Only sessions whose worker answered: discovery can miss a live container, which a later
  // runner then adopts, and a session with no container finalizes when it gets a new one.
  const ended = new Set<string>();
  const adopted = await reattach(deps, ended);
  // Without containers, no agent outlives the restart.
  finalizeEndedTurnRows(deps, deps.containerManager ? ended : null);
  return adopted;
}

async function reattach(deps: ReattachDeps, ended: Set<string>): Promise<number> {
  const {
    containerManager, runnerRegistry, sessionManager,
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

  const adoptTurn = async (sessionId: string): Promise<boolean> => {
    if (runnerRegistry.get(sessionId)) return false;
    try {
      return await followWorkerTurn(deps, sessionId);
    } catch (err) {
      liveWorkAfterRestart.add(sessionId);
      console.error(`[turn-reattach] failed to reattach ${sessionId}: ${getErrorMessage(err)}`);
      return false;
    }
  };

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
        void followLater(deps, c.sessionId);
        return false;
      }
      const session = sessionManager.get(c.sessionId);
      if (!session?.workspaceDir) return false;
      if (workerReportsNoTurn(status)) ended.add(c.sessionId);
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
            ended.delete(c.sessionId);
            console.log(
              `[worker-reclaim] Keeping stale container for ${c.sessionId}`
              + ` — its confirming probe failed: ${getErrorMessage(err)}`,
            );
            return false;
          }
          if (confirm.turnActive === true) {
            ended.delete(c.sessionId);
            console.log(
              `[worker-reclaim] Keeping stale container for ${c.sessionId}`
              + ` — a turn started between the two probes`,
            );
            // The worker's own report of that turn found no orchestrator listening yet.
            return await adoptTurn(c.sessionId);
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

      return adoptTurn(c.sessionId);
    }),
  );

  const adopted = results.filter(Boolean).length;
  if (adopted > 0) {
    console.log(`[turn-reattach] Reattached ${adopted} in-flight agent turn(s) from the previous run`);
  }
  return adopted;
}
