/**
 * The predicted queue entry — the row that stands in for a message ShipIt is
 * about to compact ahead of, from the instant the user presses send.
 *
 * Why it exists. A message sent on a merged session with "Compact the context"
 * ticked, and a context of 200K tokens or more, does not start a turn: the server
 * compacts first and the message waits in the queue (docs/295). But the server
 * only knows that after a git read and
 * a PR re-verification, so the composer used to render an ordinary bubble and
 * the bubble then collapsed into the queue strip a fraction of a second later.
 * The bubble was never true — it was the UI guessing "no compaction" by
 * default, and guessing loudly. This guesses the other way, quietly.
 *
 * **A predicted row has exactly two exits, and both are server-driven.** It
 * either becomes a server row (`adopt`, handing its bubble to the stash the
 * dequeue restores the message from) or it becomes a transcript bubble
 * (`restore`, for every answer that says the message is not waiting in a
 * queue). `drop` is the third case and not an exit at all: the send never
 * happened, so there is nothing to show either way.
 *
 * One owner for all of them, because the row is written in `send-user-message`
 * and read by four message handlers, and a row only some of them know how to
 * retire is a queue strip that never empties. The bubble travelling on the row
 * is not a second home for transcript state: `queuedMessageStash` has held the
 * composed bubble for a queued message all along, and this is the same bubble
 * reaching the same stash from one message earlier.
 */

import type { WsQueueRow } from "../../server/shared/types.js";
import type { ChatMessage } from "../components/MessageList.js";
import { useSessionStore, type QueuedMessageEntry } from "../stores/session-store.js";

const isPredicted = (entry: QueuedMessageEntry) => entry.requestId !== undefined;

/** The server names the queue entry by this `requestId` too, so the row is found by it. */
export function addPredictedQueueEntry(
  requestId: string,
  text: string,
  bubble: ChatMessage,
): void {
  useSessionStore.getState().setQueuedMessages((prev) => [
    ...prev,
    { text, position: prev.length + 1, requestId, bubble },
  ]);
}

/** The send never reached the server, so neither presentation is owed. */
export function dropPredictedQueueEntry(requestId: string): void {
  const session = useSessionStore.getState();
  if (!session.queuedMessages.some((q) => q.requestId === requestId)) return;
  session.setQueuedMessages((prev) => prev.filter((q) => q.requestId !== requestId));
}

/**
 * The server has queued the message a prediction already put on screen. Hands
 * back the bubble the row was holding so the caller can stash it for the
 * dequeue, and returns `null` when nothing predicted this message — which is
 * the signal to queue it the ordinary way.
 */
export function adoptPredictedQueueEntry(row: WsQueueRow): ChatMessage | null {
  const session = useSessionStore.getState();
  const predicted = session.queuedMessages.find((q) => isPredicted(q) && q.requestId === row.id);
  if (!predicted) return null;
  session.setQueuedMessages((prev) => placeQueueRow(prev.filter((q) => q.requestId !== row.id), row));
  return predicted.bubble ?? null;
}

/**
 * Puts a server row at its one-based position among the server rows, before the predicted
 * ones. A message the agent did not take goes back to its place in send order, which need
 * not be the end (planning#691).
 */
export function placeQueueRow(rows: QueuedMessageEntry[], row: WsQueueRow): QueuedMessageEntry[] {
  const server = rows.filter((q) => !isPredicted(q) && q.id !== row.id);
  const index = Math.min(Math.max(row.position - 1, 0), server.length);
  server.splice(index, 0, { id: row.id, text: row.text, position: row.position });
  return [...server, ...rows.filter(isPredicted)].map((q, i) => ({ ...q, position: i + 1 }));
}

/**
 * The message is not waiting in a queue after all — put it back in the
 * transcript, where an un-predicted send would have shown it all along.
 *
 * Two answers mean this. A **steer** feeds the message straight into the
 * running process, and a **refused** send ends with an error the user needs to
 * see their own message above. Callers pass the message's id when the answer
 * names one message and nothing when it names none: an ordinary server error
 * carries no request id, so every unacknowledged row it could be about is
 * restored.
 *
 * Restoring is the right direction even when the guess is wrong, because it
 * self-heals: a `message_queued` arriving afterwards finds the bubble by its id,
 * stashes it and takes it out of the transcript again, which is the path a send
 * with no prediction takes every time.
 */
export function restorePredictedQueueEntries(id?: string): void {
  const session = useSessionStore.getState();
  const restored = session.queuedMessages.filter(
    (q) => isPredicted(q) && (id === undefined || q.requestId === id),
  );
  if (restored.length === 0) return;
  const ids = new Set(restored.map((q) => q.requestId));
  session.setQueuedMessages((prev) => prev.filter((q) => !ids.has(q.requestId)));
  session.setMessages((prev) => [
    ...prev,
    ...restored.map((q) => q.bubble ?? { role: "user" as const, text: q.text }),
  ]);
}

/**
 * Fold a server queue snapshot into the rows on screen.
 *
 * A snapshot arrives on reconnect and after every dequeue, and it replaced the
 * predicted row outright — which lost the composed bubble before it ever
 * reached the stash, so a message with attachments came back from the queue as
 * bare text. So: a predicted row the snapshot **names** is confirmed, and its
 * bubble goes to the stash exactly as `message_queued` would have sent it
 * there. A predicted row the snapshot does **not** name is not disproved by it
 * — the snapshot can simply predate the send — so it survives, after the
 * server's own rows.
 */
export function applyQueueSnapshot(
  snapshot: WsQueueRow[],
  stash: (id: string, bubble: ChatMessage) => void,
): QueuedMessageEntry[] {
  const named = new Set(snapshot.map((q) => q.id));
  const predicted = useSessionStore.getState().queuedMessages.filter(isPredicted);
  for (const row of predicted) {
    if (row.requestId !== undefined && named.has(row.requestId) && row.bubble) stash(row.requestId, row.bubble);
  }
  const survivors = predicted.filter((row) => row.requestId === undefined || !named.has(row.requestId));
  return [
    ...snapshot,
    ...survivors.map((row, i) => ({ ...row, position: snapshot.length + i + 1 })),
  ];
}
