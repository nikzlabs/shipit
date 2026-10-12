/**
 * A Stop pressed while a turn is still setting up has no started process to signal: the
 * agent may not be chosen yet, or it is a resident whose listeners the new turn has not
 * wired. So Stop is recorded against the runner, and the turn honours it before it
 * submits the prompt. A runner with no record here is treated as submitted, which keeps
 * the old signal-the-process behaviour for any path that does not report its phase.
 */
interface TurnPhase {
  submitted: boolean;
  /** docs/329-user-steers-every-turn — the agent accepted the turn's own prompt. */
  ready: boolean;
  /** docs/329-user-steers-every-turn — the turn compacts the context, so it takes no message. */
  compaction: boolean;
  beganAt: number;
  /** A new object for each attempt of the turn, so an answer to an earlier one is told apart. */
  attempt: object;
  stopRequested: boolean;
  /** docs/322 — the user pressed Stop, which a question's own interrupt is not. */
  stoppedByUser: boolean;
}

const phases = new WeakMap<object, TurnPhase>();

/** Longer than a setup that works, shorter than a session left stuck. */
export const TURN_SETUP_MAX_MS = 10 * 60 * 1000;

/** `running` went from false to true: a new turn is setting up. */
export function beginTurnSetup(runner: object): void {
  phases.set(runner, {
    submitted: false,
    ready: false,
    compaction: false,
    beganAt: Date.now(),
    attempt: {},
    stopRequested: false,
    stoppedByUser: false,
  });
}

/**
 * A retry attempt sets up a fresh agent while `running` stays true. A Stop already
 * recorded for this turn is kept.
 */
export function reopenTurnSetup(runner: object): void {
  const phase = phases.get(runner);
  if (!phase) return;
  phase.submitted = false;
  phase.ready = false;
  phase.beganAt = Date.now();
  phase.attempt = {};
}

export function currentTurnAttempt(runner: object): object | undefined {
  return phases.get(runner)?.attempt;
}

export function noteCompactionTurn(runner: object, compaction: boolean): void {
  const phase = phases.get(runner);
  if (phase) phase.compaction = compaction;
}

/**
 * The agent has the turn's prompt, or runs a turn of its own. A caller that learns it after
 * an await passes the attempt it started with: a late answer must not mark the attempt or
 * the turn that came next. Returns whether the mark was made.
 */
export function noteTurnReady(runner: object, attempt?: object): boolean {
  const phase = phases.get(runner);
  if (!phase || (attempt !== undefined && attempt !== phase.attempt)) return false;
  phase.ready = true;
  return true;
}

/**
 * docs/329-user-steers-every-turn — a message enters the running turn only when the agent
 * has that turn's prompt and the turn is not a compaction. Without a record the turn reads
 * as ready, as it reads as submitted.
 */
export function turnTakesMessages(runner: { running: boolean }): boolean {
  if (!runner.running) return false;
  const phase = phases.get(runner);
  return phase === undefined || (phase.ready && !phase.compaction);
}

/**
 * The claim has no agent on the worker yet, which is the normal state of a setup. Bounded,
 * so a setup that hangs is still found.
 */
export function turnAwaitsAgent(runner: { running: boolean }, now = Date.now()): boolean {
  if (!runner.running) return false;
  const phase = phases.get(runner);
  return phase !== undefined && !phase.ready && now - phase.beganAt < TURN_SETUP_MAX_MS;
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
