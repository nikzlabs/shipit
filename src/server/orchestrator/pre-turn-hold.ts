/**
 * docs/295 — the admission hold around a turn's PRE-turn phase.
 *
 * A turn does not start at its spawn. Before it, the transport compacts a merged
 * session's context (`pre-turn-compact-hook.ts`), resolves the agent slot, and
 * moves the branch onto the latest base (`pre-turn-reset-hook.ts`) — a merge
 * probe, a compaction spawn and a `git reset --hard`, each of them seconds to
 * minutes. `running` is published across all of it, which stops another turn
 * STARTING; this hold is what additionally stops one being STEERED into the
 * process that phase is using, and what tells the drains and the container
 * reconciler that the runner is claimed.
 *
 * The whole phase, not just the compaction: the release used to sit inside the
 * compaction hook, so the branch move — the destructive half — ran with the
 * session reading admissible again.
 *
 * Owned by the two transports (`ws-handlers/agent-execution.ts`,
 * `dispatched-turn.ts`) rather than by either hook, because it is the PHASE that
 * has to be atomic and no single hook spans it. Paired in a `finally`, so a
 * throw anywhere inside cannot strand the session unable to admit anything.
 */

import type { SessionRunnerInterface } from "./session-runner.js";

/**
 * Run a turn's pre-turn phase with the session held against admission.
 *
 * A `null` runner (a degenerate/test wiring with nothing to hold) runs the phase
 * unheld rather than refusing it — there is no admission to gate.
 */
export async function withPreTurnHold<T>(
  runner: SessionRunnerInterface | null | undefined,
  phase: () => Promise<T>,
): Promise<T> {
  if (!runner) return phase();
  runner.preTurnHold = true;
  try {
    return await phase();
  } finally {
    runner.preTurnHold = false;
  }
}
