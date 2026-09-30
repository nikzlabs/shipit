import type { AnswerHoldStore, QueuedMessage, SessionRunnerInterface } from "./session-runner.js";

/**
 * docs/322-question-holds-automatic-turns req 8 — automatic turns held for the user's answer
 * live in the database, not in a runner's queue, so a stopped container or a restart cannot
 * lose them. They go back into the queue when the user starts a turn, and their row is
 * forgotten when the turn starts.
 */

/** False when there is nowhere to keep it; the caller then queues it in memory as before. */
export function holdTurn(
  store: AnswerHoldStore | undefined,
  sessionId: string,
  entry: QueuedMessage,
): boolean {
  if (!store) return false;
  try {
    store.holdTurn(sessionId, entry);
    return true;
  } catch (err) {
    console.error(`[held-turns] saving a held turn for ${sessionId} failed:`, err);
    return false;
  }
}

/** Puts the held turns back behind what the user queued (req 6). Returns how many. */
export function restoreHeldTurns(
  runner: Pick<SessionRunnerInterface, "sessionId" | "messageQueue" | "answerHoldStore" | "rebindDelivery">,
): number {
  const store = runner.answerHoldStore;
  if (!store) return 0;
  try {
    const present = new Set(runner.messageQueue.map((m) => m.heldId));
    const held = store.heldTurns(runner.sessionId)
      .filter((m) => !present.has(m.heldId))
      .map((m) => withRestartSettlement(m, runner.rebindDelivery));
    runner.messageQueue.push(...held);
    return held.length;
  } catch (err) {
    console.error(`[held-turns] restoring the held turns of ${runner.sessionId} failed:`, err);
    return 0;
  }
}

/** A restart kept the row but not the callback; a delivery its owner can re-bind gets it back. */
function withRestartSettlement(
  entry: QueuedMessage,
  rebind: SessionRunnerInterface["rebindDelivery"],
): QueuedMessage {
  if (entry.onTurnComplete || entry.deliveryId === undefined || !rebind) return entry;
  const onTurnComplete = rebind(entry.deliveryId);
  return onTurnComplete ? { ...entry, onTurnComplete } : entry;
}

export function forgetHeldTurn(store: AnswerHoldStore | undefined, entry: { heldId?: number }): void {
  if (!store || entry.heldId === undefined) return;
  try {
    store.forgetHeldTurn(entry.heldId);
  } catch (err) {
    console.error(`[held-turns] forgetting held turn ${entry.heldId} failed:`, err);
  }
}

/** A stop discards the queue, and the held turns in it with it. */
export function forgetHeldEntries(store: AnswerHoldStore | undefined, queue: readonly QueuedMessage[]): void {
  for (const entry of queue) forgetHeldTurn(store, entry);
}

/** A runner that goes away does not settle its held turns: they are saved, and come back. */
export function withoutHeldEntries(queue: readonly QueuedMessage[]): QueuedMessage[] {
  return queue.filter((m) => m.heldId === undefined);
}

export function hasHeldDelivery(
  store: AnswerHoldStore | undefined,
  sessionId: string,
  deliveryId: string,
): boolean {
  if (!store) return false;
  try {
    return store.hasHeldDelivery(sessionId, deliveryId);
  } catch (err) {
    console.error(`[held-turns] reading the held turns of ${sessionId} failed:`, err);
    return false;
  }
}
