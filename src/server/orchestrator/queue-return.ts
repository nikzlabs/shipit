import type { FileContextRef, WsReturnedQueueMessage } from "../shared/types.js";
import type { QueuedMessage, SessionRunnerInterface } from "./session-runner.js";
import { forgetHeldEntries } from "./held-turns.js";
import { nextSendOrder, queueEntryId } from "./queue-identity.js";
import { settleDroppedQueueEntries } from "./turn-settlement.js";

/**
 * docs/330-stop-returns-queued-messages — the user's Stop empties the queue. A message that
 * the user sent waits here until an input box has it; every other entry is settled as dropped.
 */

type StoppedRunner = Pick<
  SessionRunnerInterface,
  "sessionId" | "messageQueue" | "answerHoldStore" | "emitMessage" | "getQueueSnapshot"
>;

interface Returned {
  message: WsReturnedQueueMessage;
  sendOrder: number | undefined;
}

const returnedByRunner = new WeakMap<object, Returned[]>();

/** The send order of the runner's last Stop. Send orders only grow, so it is never cleared. */
const stopCutoffs = new WeakMap<object, number>();

/** A message that this session's user sent in the chat: typed, or an answer on a question card. */
export function isUsersOwnEntry(entry: QueuedMessage): boolean {
  return entry.execution === "interactive"
    && entry.automatic !== true
    && entry.messageOrigin === undefined
    && entry.steeredDispatch !== true;
}

function toReturned(entry: QueuedMessage): WsReturnedQueueMessage {
  const files = new Map<string, FileContextRef>();
  for (const file of entry.files ?? []) if (!files.has(file.path)) files.set(file.path, file);
  const uploads = [...(entry.uploads ?? []).map((u) => u.path), ...(entry.uploadPaths ?? [])];
  for (const path of uploads) if (!files.has(path)) files.set(path, { path });
  return {
    id: queueEntryId(entry),
    text: entry.text,
    ...(files.size > 0 ? { files: [...files.values()] } : {}),
  };
}

function leaveQueue(runner: StoppedRunner, leaving: QueuedMessage[]): void {
  if (leaving.length === 0) return;
  const queue = runner.messageQueue;
  queue.splice(0, queue.length, ...queue.filter((m) => !leaving.includes(m)));
  forgetHeldEntries(runner.answerHoldStore, leaving);

  const own = leaving.filter(isUsersOwnEntry);
  if (own.length > 0) {
    const waiting = [
      ...(returnedByRunner.get(runner) ?? []),
      ...own.map((entry) => ({ message: toReturned(entry), sendOrder: entry.sendOrder })),
    ];
    waiting.sort((a, b) => (a.sendOrder ?? Infinity) - (b.sendOrder ?? Infinity));
    returnedByRunner.set(runner, waiting);
  }
  settleDroppedQueueEntries(leaving, "stopped by the user");

  const returned = returnedMessages(runner);
  runner.emitMessage({
    type: "queue_updated",
    sessionId: runner.sessionId,
    queue: runner.getQueueSnapshot(),
    ...(returned.length > 0 ? { returned } : {}),
  });
}

/** Returns whether an entry left the queue. */
export function returnQueueOnStop(runner: StoppedRunner): boolean {
  stopCutoffs.set(runner, nextSendOrder());
  const leaving = [...runner.messageQueue];
  leaveQueue(runner, leaving);
  return leaving.length > 0;
}

/** An entry with no send order is never taken for one sent before the Stop. */
export function sentBeforeStop(runner: object, sendOrder: number | undefined): boolean {
  const cutoff = stopCutoffs.get(runner);
  return cutoff !== undefined && sendOrder !== undefined && sendOrder < cutoff;
}

/**
 * An entry that was sent before the last Stop can enter the queue after it: a steer that the
 * agent did not take, or a message that a compaction is put ahead of. It leaves here, before
 * a drain or a delivery uses it.
 */
export function returnQueueSentBeforeStop(runner: StoppedRunner): void {
  leaveQueue(runner, runner.messageQueue.filter((m) => sentBeforeStop(runner, m.sendOrder)));
}

/** A message that was on its way when the user pressed Stop: it gets the Stop's rule, not a turn. */
export function returnLateEntry(runner: StoppedRunner, entry: QueuedMessage): void {
  leaveQueue(runner, [entry]);
}

/** The messages that wait for an input box, in send order. */
export function returnedMessages(runner: object): WsReturnedQueueMessage[] {
  return (returnedByRunner.get(runner) ?? []).map((r) => r.message);
}

/** A viewer's input box holds these now. */
export function takeReturnedMessages(runner: object, ids: readonly string[]): void {
  const waiting = returnedByRunner.get(runner);
  if (!waiting) return;
  const taken = new Set(ids);
  returnedByRunner.set(runner, waiting.filter((r) => !taken.has(r.message.id)));
}
