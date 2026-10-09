/**
 * A Stop pressed while a turn is still setting up has no started process to signal: the
 * agent may not be chosen yet, or it is a resident whose listeners the new turn has not
 * wired. So Stop is recorded against the runner, and the turn honours it before it
 * submits the prompt. A runner with no record here is treated as submitted, which keeps
 * the old signal-the-process behaviour for any path that does not report its phase.
 */
interface TurnPhase {
  submitted: boolean;
  stopRequested: boolean;
  /** docs/322 — the user pressed Stop, which a question's own interrupt is not. */
  stoppedByUser: boolean;
}

const phases = new WeakMap<object, TurnPhase>();

/** `running` went from false to true: a new turn is setting up. */
export function beginTurnSetup(runner: object): void {
  phases.set(runner, { submitted: false, stopRequested: false, stoppedByUser: false });
}

/**
 * A retry attempt sets up a fresh agent while `running` stays true. A Stop already
 * recorded for this turn is kept.
 */
export function reopenTurnSetup(runner: object): void {
  const phase = phases.get(runner);
  if (phase) phase.submitted = false;
}

/** The prompt reached the agent, or the turn is one the CLI started itself. */
export function noteTurnSubmitted(runner: object): void {
  const phase = phases.get(runner);
  if (phase) phase.submitted = true;
}

/** False when the turn is past setup, so the caller must signal the process itself. */
export function requestStopDuringSetup(runner: object): boolean {
  const phase = phases.get(runner);
  if (!phase || phase.submitted) return false;
  phase.stopRequested = true;
  return true;
}

/** True once per Stop recorded during setup; the turn must not submit its prompt. */
export function consumeSetupStop(runner: object): boolean {
  const phase = phases.get(runner);
  if (!phase?.stopRequested) return false;
  phase.stopRequested = false;
  return true;
}

/** A turn holds `running` and has not submitted its prompt yet. */
export function turnInSetup(runner: object): boolean {
  const phase = phases.get(runner);
  return phase !== undefined && !phase.submitted;
}

/** The turn now setting up or running: every false → true of `running` begins a new one. */
export function currentTurnPhase(runner: object): object | undefined {
  return phases.get(runner);
}

export function noteUserStop(runner: object): void {
  const phase = phases.get(runner);
  if (phase) phase.stoppedByUser = true;
}

export function stoppedByUser(runner: object): boolean {
  return phases.get(runner)?.stoppedByUser === true;
}
