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

/**
 * A notice riding a turn's prompt, written off only once the agent has produced
 * a result for that prompt (docs/299-agent-settings-access req 8, whose
 * `plan.md` carries the argument).
 *
 * A **positive** signal, deliberately, and not a verdict over `TurnOutcome`: a
 * provider refusal on a route that cannot fail over settles the turn `completed`
 * with nothing having run, and a resident streaming turn settles no turn at all.
 */
export interface NoticeDelivery {
  /** Idempotent: a turn may reach this point once, and must not need to. */
  delivered(): void;
}

/**
 * One-shot state a prompt TOOK at composition, put back when no attempt of the turn ever
 * submitted that prompt (planning#609).
 *
 * The mirror of {@link NoticeDelivery}, and needed for the same reason: a take spent at
 * composition belongs to the agent that reads it, not to the turn that asked. Where a
 * notice delivery writes a take off once the agent answered, a repark restores one the
 * agent was never asked about — and a turn ends that way routinely, because
 * `prepareAgentEnv` refuses a spent account before the prompt is submitted and the error
 * tells the user to send the message again.
 */
export interface PromptRepark {
  /** Idempotent: a turn can reach this point from more than one path. */
  repark(): void;
}

/**
 * A repark that runs once and never throws. It is called from a turn's terminal sequence,
 * where a throw would abandon the steps behind it (CLAUDE.md invariant 3).
 */
export function createPromptRepark(label: string, restore: () => void): PromptRepark {
  let reparked = false;
  return {
    repark(): void {
      if (reparked) return;
      reparked = true;
      try {
        restore();
      } catch (err) {
        console.error(`[turn] re-parking ${label} failed:`, err);
      }
    },
  };
}

/**
 * Whether a turn result is the agent's own work rather than a report that its
 * prompt did not run. No shipped adapter sets `error` on a non-`error` status,
 * so the first clause is a guard against one that does: the cost of being wrong
 * here is a notice consumed by a turn the agent never processed.
 */
export function resultIsTheAgentsOwn(result: { status?: string; error?: string }): boolean {
  return !result.error && result.status !== "error";
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
