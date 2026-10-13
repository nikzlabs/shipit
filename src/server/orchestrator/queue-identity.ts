import { randomUUID } from "node:crypto";
import type { WsQueueRow } from "../shared/types.js";
import type { QueuedMessage, SessionRunnerInterface } from "./session-runner.js";

let lastSendOrder = 0;

/**
 * planning#691 — the order in which messages reached ShipIt, across every runner of this
 * process. A message takes it when ShipIt accepts it (docs/330); one that has none by then
 * takes it when it is queued or steered.
 */
export function nextSendOrder(): number {
  lastSendOrder += 1;
  return lastSendOrder;
}

/**
 * planning#691 — the id that a queue row and the bubble of its message share: the sender's
 * request id, or one made here the first time a viewer is told of the entry.
 */
export function queueEntryId(entry: QueuedMessage): string {
  entry.clientRequestId ??= randomUUID();
  return entry.clientRequestId;
}

export function queueSnapshot(queue: readonly QueuedMessage[]): WsQueueRow[] {
  return queue.map((entry, index) => ({ id: queueEntryId(entry), text: entry.text, position: index + 1 }));
}

/**
 * Puts back a message whose steer the agent did not take, in front of every entry sent after
 * it: a correction the user sent later must not run before the message it corrects. An entry
 * with no send order is never passed. Returns the one-based position.
 */
export function requeueInSendOrder(
  runner: Pick<SessionRunnerInterface, "enqueue" | "messageQueue">,
  entry: QueuedMessage,
): number {
  const position = runner.enqueue(entry);
  const order = entry.sendOrder;
  if (order === undefined) return position;
  const queue = runner.messageQueue;
  const later = queue.findIndex((m) => m !== entry && m.sendOrder !== undefined && m.sendOrder > order);
  if (later === -1) return position;
  queue.splice(queue.indexOf(entry), 1);
  queue.splice(later, 0, entry);
  return later + 1;
}
