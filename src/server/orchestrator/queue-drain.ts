import type {
  QueuedMessage,
  SessionRunnerInterface,
} from "./session-runner.js";
import { queuedMessageToDispatchOptions } from "./prepared-dispatch.js";
import { automaticTurnHeldForAnswer, systemTurnBlockedByResidentWork } from "./turn-admission.js";
import { settleDroppedQueueEntries } from "./turn-settlement.js";

export { queuedMessageToDispatchOptions };

/**
 * Take the queue's head, or leave it in place when a gate `dispatchOnRunner` would have
 * enqueued for still holds (planning#562). Every drain that runs its entry WITHOUT going
 * back through `runner.dispatch` must take it here: gating and taking are one act because
 * a site that has already claimed the runner has no cheap way to put the entry back.
 *
 * A deferred entry stays at the head, and `releaseQueuedTurn` is how it gets going again:
 * every site that releases one of these gates calls it.
 */
export function takeRunnableQueuedTurn(
  runner: SessionRunnerInterface,
): QueuedMessage | undefined {
  const queue = runner.messageQueue;
  const head = queue[0];
  if (!head) return undefined;
  const held = automaticTurnHeldForAnswer(runner, head.automatic);
  if (held) {
    // docs/321 req 6 — the user's own entries do not wait behind held automatic work.
    const index = queue.findIndex((m) => m.automatic !== true);
    if (index === -1) {
      console.log(`[queue] holding ${queue.length} automatic turn(s) for ${runner.sessionId} — ${held}`);
      return undefined;
    }
    return takeIfUnblocked(runner, index);
  }
  return takeIfUnblocked(runner, 0);
}

function takeIfUnblocked(runner: SessionRunnerInterface, index: number): QueuedMessage | undefined {
  const blocked = systemTurnBlockedByResidentWork(runner, runner.messageQueue[index]?.systemTurn);
  if (blocked) {
    console.warn(
      `[queue] holding the queued system turn for ${runner.sessionId} — ${blocked}`,
    );
    return undefined;
  }
  return index === 0 ? runner.dequeue() : runner.messageQueue.splice(index, 1)[0];
}

/**
 * An interrupted turn discards what was queued behind it. docs/321 — a turn that ended on a
 * question keeps its automatic entries: they are held for the user's answer, not cancelled.
 */
export function discardQueueAfterInterrupt(runner: SessionRunnerInterface): void {
  if (!runner.awaitingUserAnswer) {
    runner.clearQueue();
    return;
  }
  const queue = runner.messageQueue;
  const dropped = queue.filter((m) => m.automatic !== true);
  if (dropped.length === 0) return;
  queue.splice(0, queue.length, ...queue.filter((m) => m.automatic === true));
  settleDroppedQueueEntries(dropped, "queue cleared");
}

// The tagged executor preserves callbacks and system-turn options across queue drains.
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
 * Start the head of the queue if every gate now allows it. Call this from wherever a gate
 * is released — nothing else revisits an entry that a drain already passed over.
 */
export function releaseQueuedTurn(runner: SessionRunnerInterface): boolean {
  // A system flow can hold the workspace between turns; merge holds also prevent queue flicker.
  if (runner.running || runner.systemTurnInProgress || runner.mergeHold || runner.queueLength === 0) return false;
  // Without dispatch dependencies, this would only move the entry to the queue's tail.
  if (!runner.canRunDispatchedTurn) return false;
  // Same take as a drain: a gate that still holds must leave the entry where it is, since
  // dispatch would otherwise re-queue it behind everything else.
  const next = takeRunnableQueuedTurn(runner);
  if (!next) return false;
  runner.emitMessage({ type: "queue_updated", queue: runner.getQueueSnapshot() });
  // dispatch re-queues safely if another turn has claimed the runner.
  runner.dispatch(queuedMessageToDispatchOptions(next));
  return true;
}
