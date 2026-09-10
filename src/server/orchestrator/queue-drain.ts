import type {
  QueuedMessage,
  SessionRunnerInterface,
} from "./session-runner.js";
import { queuedMessageToDispatchOptions } from "./prepared-dispatch.js";

export { queuedMessageToDispatchOptions };

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

export function releaseQueuedTurn(runner: SessionRunnerInterface): boolean {
  // A system flow can hold the workspace between turns; merge holds also prevent queue flicker.
  if (runner.running || runner.systemTurnInProgress || runner.mergeHold || runner.queueLength === 0) return false;
  // Without dispatch dependencies, this would only move the entry to the queue's tail.
  if (!runner.canRunDispatchedTurn) return false;
  const next = runner.dequeue();
  if (!next) return false;
  runner.emitMessage({ type: "queue_updated", queue: runner.getQueueSnapshot() });
  // dispatch re-queues safely if another turn has claimed the runner.
  runner.dispatch(queuedMessageToDispatchOptions(next));
  return true;
}
