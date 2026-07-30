/**
 * Turn settlement — the owned, resolve-exactly-once completion signal for a
 * dispatched turn (docs/240, Fix B).
 *
 * Completion used to be an unowned callback riding along as one more optional
 * field on `AgentDispatchOptions`. Nothing owned the invariant "this dispatch
 * signals completion exactly once", so the callback could be dropped in transit
 * (SHI-254 lost it on the steer path, SHI-255 and SHI-259 lost it at hand-rolled
 * queue drains) or guarded so carefully against a double fire that it fired zero
 * times (SHI-260 passed it only to attempt zero of a retrying turn). Worse, the
 * *consumer* could not tell **pending** from **lost**, which is why every one of
 * those bugs manifested as a watch silently stranded at `merge-observed` rather
 * than as an error.
 *
 * A settlement inverts that. `dispatch` returns a {@link TurnHandle} whose
 * `settled` promise the turn machinery resolves exactly once, from a `finally`,
 * with a {@link TurnOutcome} that CARRIES the failure case. You cannot drop a
 * settlement; you can only fail to resolve one, which is observable (a consumer
 * awaiting it hangs instead of concluding "delivered") rather than silent.
 *
 * `onTurnComplete` survives as a thin adapter over this so the ~15 dispatch call
 * sites migrate incrementally rather than in one big-bang commit — see
 * `prepared-dispatch.ts`'s `withSettlement`.
 */

import type { QueuedMessage } from "./session-runner.js";

/**
 * How a turn ended. `completed` is the ONLY success — every other status means
 * the dispatched work did not run to a clean finish, and a consumer that treats
 * them as delivered is reproducing the bug docs/240 exists to close (docs/239
 * flagged `wakeSessionWithTurn` discarding the `errored` case for exactly this
 * reason).
 *
 *   - `completed`  — the agent produced a turn result and the turn tore down cleanly.
 *   - `errored`    — the turn ended via an agent process error.
 *   - `no-result`  — the process exited without ever producing a turn result, and
 *                    the no-result retry budget (if any) was spent.
 *   - `steered`    — the message was injected into an already-running turn
 *                    (live steering) instead of running as its own turn, so
 *                    there is no separate completion to wait for.
 *   - `dropped`    — the turn was discarded before it ever ran: its queue entry
 *                    was cleared (user interrupt) or the runner was disposed.
 */
export type TurnOutcomeStatus = "completed" | "errored" | "no-result" | "steered" | "dropped";

export interface TurnOutcome {
  readonly status: TurnOutcomeStatus;
  /**
   * Legacy projection kept for the pre-docs/240 `onTurnComplete({ errored })`
   * consumers (the rebase driver, the CI auto-fix loop). It means exactly what
   * it always meant — "the turn ended via an agent process error" — and is
   * deliberately NOT widened to "did not complete cleanly", so migrating a
   * caller to `status` is an explicit, reviewable decision rather than a silent
   * behavior change. New consumers should branch on `status`.
   */
  readonly errored: boolean;
  /** Human-readable detail for the non-`completed` statuses. */
  readonly detail?: string;
}

/** The handle `dispatch` hands back. Resolves exactly once. */
export interface TurnHandle {
  /** Resolves exactly once, when the turn reaches a terminal outcome. */
  readonly settled: Promise<TurnOutcome>;
}

/** The producer side of a {@link TurnHandle}. Held by whoever owns the turn. */
export interface TurnSettlement extends TurnHandle {
  /** Resolve the handle. Idempotent — every call after the first is a no-op. */
  settle(outcome: TurnOutcome): void;
  /** True once `settle` has been called. */
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

/**
 * Create a fresh settlement. The promise NEVER rejects — a failed turn is a
 * resolved `TurnOutcome` with a failure status, so a caller that only wants the
 * success case (`void handle.settled.then(...)`) can't strand an unhandled
 * rejection on the orchestrator.
 */
export function createTurnSettlement(): TurnSettlement {
  let resolve!: (outcome: TurnOutcome) => void;
  const promise = new Promise<TurnOutcome>((res) => { resolve = res; });
  let settled = false;
  return {
    settled: promise,
    get isSettled() { return settled; },
    settle(outcome: TurnOutcome): void {
      if (settled) return;
      settled = true;
      resolve(outcome);
    },
  };
}

/**
 * Settle every queued entry that is being thrown away, then leave the array
 * empty. Called from `clearQueue` / runner disposal.
 *
 * Before docs/240 a cleared queue silently ate any completion signal riding on
 * it: a notify-on-merge wake-turn enqueued behind a turn the user then
 * interrupted was dropped, its `onTurnComplete` never fired, and the watch sat
 * at `merge-observed` looking healthy until an orchestrator restart. Settling
 * with `dropped` turns that into a signal the consumer can act on (the SHI-258
 * retry supervisor re-attempts it on a backoff).
 */
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
