import type { SessionRunnerInterface, SystemTurnDeps } from "./session-runner.js";

export const ANSWER_HOLD_REASON = "the agent is waiting for the user's answer";

/**
 * A stopped scheduled run holds automatic turns too (docs/324-scheduled-sessions req 33).
 * A failed read counts as not held: a closed database must not freeze the queue.
 */
export function readAnswerHold(
  deps: Pick<SystemTurnDeps, "answerHold"> | null,
  sessionId: string,
): boolean {
  if (!deps?.answerHold) return false;
  try {
    return deps.answerHold.automaticTurnsHeld(sessionId);
  } catch (err) {
    console.error(`[admission] reading the answer hold for ${sessionId} failed:`, err);
    return false;
  }
}

/**
 * Never throws: its callers sit where a throw would abandon a turn's start or its commit.
 * Returns whether the mark changed.
 */
export function writeAnswerHold(
  deps: Pick<SystemTurnDeps, "answerHold">,
  sessionId: string,
  awaiting: boolean,
): boolean {
  if (!deps.answerHold) return false;
  try {
    return deps.answerHold.setAwaitingAnswer(sessionId, awaiting);
  } catch (err) {
    console.error(`[admission] writing the answer hold for ${sessionId} failed:`, err);
    return false;
  }
}

/** docs/322 — why an automatic turn cannot start now, or null. Read by dispatch and by the drain. */
export function automaticTurnHeldForAnswer(
  runner: Pick<SessionRunnerInterface, "answerHold">,
  automatic: boolean | undefined,
): string | null {
  if (automatic !== true) return null;
  return runner.answerHold ? ANSWER_HOLD_REASON : null;
}

/**
 * Why a turn cannot start while the turn before it is not in git yet, or null — post-turn
 * invariant 1, for a turn that arrives from outside the queue. A driver-owned step is exempt:
 * it runs inside the driver's own hold and commits nothing.
 */
export function turnBlockedByPendingCommit(
  runner: Pick<SessionRunnerInterface, "turnCommitPending">,
  turn: { systemTurn?: boolean | undefined; postTurn?: "commit-push" | "none" | undefined },
): string | null {
  if (!runner.turnCommitPending) return null;
  if (turn.systemTurn === true && turn.postTurn === "none") return null;
  return "the previous turn's work is not committed yet";
}

const TURN_COMMIT_POLL_MS = 20;

/**
 * For a caller that starts its turn itself and so cannot be queued: resolves once the
 * runner's finished turn is in git. Bounded, because the hold expires on its own deadline.
 * Returns early when another turn has claimed the runner; the caller's own gates read that.
 */
export async function turnCommitSettled(
  runner: Pick<SessionRunnerInterface, "turnCommitPending" | "running" | "disposed"> | null | undefined,
): Promise<void> {
  if (!runner) return;
  const waiting = (): boolean => runner.turnCommitPending && !runner.running && !runner.disposed;
  while (waiting()) {
    await new Promise((resolve) => setTimeout(resolve, TURN_COMMIT_POLL_MS));
  }
}

/** Everything an admission gate may read; a drain site holds no more than this. */
export type AdmissionRunner = Pick<
  SessionRunnerInterface,
  "getAgent" | "backgroundWorkDescriptions"
>;

/**
 * Background work a system turn would destroy by replacing the resident process. Callers
 * that pre-flight this gate must read it here, or their check drifts from the gate's.
 */
export function residentBackgroundWork(runner: AdmissionRunner): string[] {
  return runner.getAgent() !== null ? runner.backgroundWorkDescriptions : [];
}

/**
 * Why a system turn cannot start on this runner now, or null. `dispatchOnRunner` reads it to
 * decide whether to enqueue, and a drain that runs its entry without re-entering dispatch
 * reads the same function, so the two answers cannot drift (planning#562).
 */
export function systemTurnBlockedByResidentWork(
  runner: AdmissionRunner,
  systemTurn: boolean | undefined,
): string | null {
  if (systemTurn !== true) return null;
  const work = residentBackgroundWork(runner);
  if (work.length === 0) return null;
  return "the resident agent has background work in flight "
    + `(${work.join(", ")}), which a system turn would destroy`;
}
