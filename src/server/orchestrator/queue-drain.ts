/**
 * The one place a queued message is turned back into a running turn (planning#257).
 *
 * A session has a single in-memory message queue but TWO drains: the dispatched
 * turn's own post-turn drain (`dispatched-turn.ts`) and the WS interactive
 * turn's (`ws-handlers/agent-execution.ts`). They used to convert a
 * `QueuedMessage` back into a turn independently, and the interactive one only
 * knew about text, images, files, and the agent session id. So a wake-turn
 * (docs/196) queued behind a *user* turn — the common case, since a busy parent
 * is busy precisely because a user turn is running — silently lost its
 * `systemTurn` marker AND its `onTurnComplete` callback: it ran as an ordinary
 * interactive turn and the merge watch never advanced past `merge-observed`, so
 * `reconcilePending` re-fired it on every orchestrator restart.
 *
 * The fix is structural rather than a third field-copy to keep in sync: every
 * queued entry is TAGGED at enqueue with the executor that must run it
 * (`QueuedMessage.execution`), and both drains route through
 * `startQueuedMessage` here. A `"dispatched"` entry is converted by
 * `queuedMessageToDispatchOptions` — which carries the full option set — and
 * handed to `runner.runDispatchedTurn`; only a `"interactive"` entry ever
 * reaches a transport's own narrower re-entry.
 *
 * planning#261 then proved that "cannot reintroduce the bug without deliberately
 * bypassing this module" was wishful thinking: turn adoption added a FOURTH
 * hand-rolled drain days later, by an author reasonably following the code
 * around them. So docs/240 moved the rule into the type system —
 * `queuedMessageToDispatchOptions` (now in `prepared-dispatch.ts`, re-exported
 * here for its historical import path) returns a BRANDED `PreparedDispatch`, and
 * `dispatch` / `runDispatchedTurn` accept nothing else. A drain that builds an
 * object literal no longer compiles.
 */

import type {
  QueuedMessage,
  SessionRunnerInterface,
} from "./session-runner.js";
import { queuedMessageToDispatchOptions } from "./prepared-dispatch.js";

// The converter itself lives with the brand it produces (`prepared-dispatch.ts`
// owns the module-private symbol, so it is the only file that can mint one).
// Re-exported here so every existing `from "./queue-drain.js"` import keeps
// working and the drain story stays readable from this module.
export { queuedMessageToDispatchOptions };

/**
 * Run a dequeued message on the executor it was tagged for.
 *
 * `runInteractive` is the caller's own (necessarily narrower) re-entry and is
 * invoked ONLY for `execution: "interactive"` entries. Server-dispatched entries
 * go back through `runner.runDispatchedTurn` with the full option set.
 *
 * Fallback: a runner with no system-turn deps wired (minimal/degenerate setups —
 * `dispatch` itself falls back to a plain enqueue there) can't run the dispatched
 * executor, so the entry runs interactively rather than being dropped. Logged,
 * because anything riding on `onTurnComplete` will not fire.
 */
export async function startQueuedMessage(
  runner: SessionRunnerInterface,
  next: QueuedMessage,
  runInteractive: (next: QueuedMessage) => Promise<void>,
): Promise<void> {
  if (next.execution !== "dispatched") return runInteractive(next);
  if (!runner.canRunDispatchedTurn) {
    console.warn(
      `[queue] runner=${runner.sessionId} has no system-turn deps; running a dispatched queue entry ` +
        `on the interactive path (systemTurn/onTurnComplete will not apply)`,
    );
    return runInteractive(next);
  }
  await runner.runDispatchedTurn(queuedMessageToDispatchOptions(next));
}

/**
 * Release the head of an idle runner's queue onto the branded dispatch path.
 * Returns true when an entry was started.
 *
 * This is the drain for the paths that have NO turn of their own to hang off —
 * a turn that ended without running (an auto-conflict-resolve attempt that
 * settled, planning#282's stuck-running recovery). Every other drain is reached from
 * a turn that actually ran and can re-enter its own executor; these can only
 * ask the runner to start the next thing.
 *
 * `runner.dispatch` (not `runDispatchedTurn`) is deliberate: `dispatch` is the
 * send-or-queue rule, so if something else claimed the runner between the
 * caller's check and this call the entry is simply re-queued rather than racing
 * the turn already starting. `queuedMessageToDispatchOptions` is the module rule
 * — see the docblock at the top of this file for why a hand-rolled field copy
 * here is the recurring bug and not a shortcut.
 */
export function releaseQueuedTurn(runner: SessionRunnerInterface): boolean {
  // planning#338 — `systemTurnInProgress` without `running` is a system FLOW (the
  // rebase driver) holding the session between its own turns while it runs git
  // against the workspace. Releasing a user turn into that window is how a
  // production session stranded mid-rebase: the released turn displaced the
  // conflict-resolution agent and nothing ever ran `git rebase --continue` or
  // `--abort`. The flow releases the queue itself when it settles.
  // docs/288 req 6 — `mergeHold` for the same reason: `dispatch` would only
  // re-queue the entry, so dequeuing here costs a `queue_updated` broadcast that
  // shows the queue shrinking and growing again.
  if (runner.running || runner.systemTurnInProgress || runner.mergeHold || runner.queueLength === 0) return false;
  // A runner with no system-turn deps can't start a dispatched turn at all
  // (`dispatch` falls back to a plain enqueue), so dequeuing here would only
  // shuffle the entry to the back of its own queue.
  if (!runner.canRunDispatchedTurn) return false;
  const next = runner.dequeue();
  if (!next) return false;
  runner.emitMessage({ type: "queue_updated", queue: runner.getQueueSnapshot() });
  runner.dispatch(queuedMessageToDispatchOptions(next));
  return true;
}
