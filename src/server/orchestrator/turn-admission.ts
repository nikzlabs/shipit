import type { SessionRunnerInterface } from "./session-runner.js";

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
