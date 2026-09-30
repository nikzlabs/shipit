import type { SessionRunnerInterface, SystemTurnDeps } from "./session-runner.js";

export const ANSWER_HOLD_REASON = "the agent is waiting for the user's answer";

/** A failed read counts as not held: a closed database must not freeze the queue. */
export function readAnswerHold(
  deps: Pick<SystemTurnDeps, "answerHold"> | null,
  sessionId: string,
): boolean {
  if (!deps?.answerHold) return false;
  try {
    return deps.answerHold.isAwaitingAnswer(sessionId);
  } catch (err) {
    console.error(`[admission] reading the answer hold for ${sessionId} failed:`, err);
    return false;
  }
}

/** Never throws: its callers sit where a throw would abandon a turn's start or its commit. */
export function writeAnswerHold(
  deps: Pick<SystemTurnDeps, "answerHold">,
  sessionId: string,
  awaiting: boolean,
): void {
  if (!deps.answerHold) return;
  try {
    deps.answerHold.setAwaitingAnswer(sessionId, awaiting);
  } catch (err) {
    console.error(`[admission] writing the answer hold for ${sessionId} failed:`, err);
  }
}

/** docs/321 — why an automatic turn cannot start now, or null. Read by dispatch and by the drain. */
export function automaticTurnHeldForAnswer(
  runner: Pick<SessionRunnerInterface, "answerHold">,
  automatic: boolean | undefined,
): string | null {
  if (automatic !== true) return null;
  return runner.answerHold ? ANSWER_HOLD_REASON : null;
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
