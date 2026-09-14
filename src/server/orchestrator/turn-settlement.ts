import type { QueuedMessage } from "./session-runner.js";

export type TurnOutcomeStatus =
  | "completed"
  | "errored"
  | "no-result"
  | "steered"
  | "dropped"
  | "interrupted"
  | "refused";

export interface TurnOutcome {
  readonly status: TurnOutcomeStatus;
  /** Legacy flag; new consumers should use status. Interrupted turns keep this false. */
  readonly errored: boolean;
  readonly detail?: string;
}

/**
 * How the dispatch entered the runner, decided synchronously. `"queued"` is the one a
 * caller cannot otherwise see: the turn has NOT started, and it settles only once
 * whatever holds the session releases it.
 */
export type TurnAdmission = "started" | "queued" | "steered" | "refused";

export interface TurnHandle {
  readonly settled: Promise<TurnOutcome>;
  /** Admission only: pre-turn compaction can still re-queue a dispatch reported "started". */
  readonly admitted: TurnAdmission;
}

export interface TurnSettlement extends TurnHandle {
  /** Only the first call resolves the handle. */
  settle(outcome: TurnOutcome): void;
  noteAdmission(admitted: TurnAdmission): void;
  readonly isSettled: boolean;
}

export const TURN_COMPLETED: TurnOutcome = { status: "completed", errored: false };
export const TURN_STEERED: TurnOutcome = { status: "steered", errored: false };

export function turnErrored(detail?: string): TurnOutcome {
  return { status: "errored", errored: true, ...(detail ? { detail } : {}) };
}

export function turnNoResult(detail?: string): TurnOutcome {
  return { status: "no-result", errored: false, ...(detail ? { detail } : {}) };
}

export function turnDropped(detail?: string): TurnOutcome {
  return { status: "dropped", errored: true, ...(detail ? { detail } : {}) };
}

export function turnInterrupted(detail?: string): TurnOutcome {
  return { status: "interrupted", errored: false, ...(detail ? { detail } : {}) };
}

/** Never admitted: the dispatch asked to fail rather than wait in the queue. */
export function turnRefused(detail: string): TurnOutcome {
  return { status: "refused", errored: true, detail };
}

/** Failures resolve with an outcome; the promise never rejects. */
export function createTurnSettlement(): TurnSettlement {
  let resolve!: (outcome: TurnOutcome) => void;
  const promise = new Promise<TurnOutcome>((res) => { resolve = res; });
  let settled = false;
  let admitted: TurnAdmission = "started";
  return {
    settled: promise,
    get isSettled() { return settled; },
    get admitted() { return admitted; },
    noteAdmission(next: TurnAdmission): void {
      admitted = next;
    },
    settle(outcome: TurnOutcome): void {
      if (settled) return;
      settled = true;
      resolve(outcome);
    },
  };
}

/** Settle discarded entries before the caller clears the queue. */
export function settleDroppedQueueEntries(queue: QueuedMessage[], reason: string): void {
  for (const entry of queue) {
    if (!entry.onTurnComplete) continue;
    try {
      entry.onTurnComplete(turnDropped(reason));
    } catch (err) {
      console.error("[turn-settlement] dropped-entry callback threw:", err);
    }
  }
}
