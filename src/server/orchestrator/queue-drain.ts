/**
 * The one place a queued message is turned back into a running turn (SHI-255).
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
 * SHI-259 then proved that "cannot reintroduce the bug without deliberately
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
