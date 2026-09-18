/**
 * The predicted queue entry — the row that stands in for a message ShipIt is
 * about to compact ahead of, from the instant the user presses send.
 *
 * Why it exists. A message sent on a merged session with "Compact the context"
 * ticked does not start a turn: the server compacts first and the message waits
 * in the queue (docs/295). But the server only knows that after a git read and
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

import type { ChatMessage } from "../components/MessageList.js";
import { useSessionStore, type QueuedMessageEntry } from "../stores/session-store.js";

const isPredicted = (entry: QueuedMessageEntry) => entry.requestId !== undefined;

/** Keyed by `text` too, because that is all `message_queued` echoes back. */
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
export function adoptPredictedQueueEntry(text: string, position: number): ChatMessage | null {
  const session = useSessionStore.getState();
  const predicted = session.queuedMessages.find((q) => isPredicted(q) && q.text === text);
  if (!predicted) return null;
  session.setQueuedMessages((prev) =>
    prev.map((q) => (q.requestId === predicted.requestId ? { text, position } : q)),
  );
  return predicted.bubble ?? null;
}

/**
 * The message is not waiting in a queue after all — put it back in the
 * transcript, where an un-predicted send would have shown it all along.
 *
 * Two answers mean this. A **steer** feeds the message straight into the
 * running process, and a **refused** send ends with an error the user needs to
 * see their own message above. Callers pass `text` when the answer names one
 * message and nothing when it names none: an ordinary server error carries no
 * request id, so every unacknowledged row it could be about is restored.
 *
 * Restoring is the right direction even when the guess is wrong, because it
 * self-heals: a `message_queued` arriving afterwards finds the bubble by text,
 * stashes it and takes it out of the transcript again, which is the path a send
 * with no prediction takes every time.
 */
export function restorePredictedQueueEntries(text?: string): void {
  const session = useSessionStore.getState();
  const restored = session.queuedMessages.filter(
    (q) => isPredicted(q) && (text === undefined || q.text === text),
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
  snapshot: { text: string; position: number }[],
  stash: (text: string, bubble: ChatMessage) => void,
): QueuedMessageEntry[] {
  const named = new Set(snapshot.map((q) => q.text));
  const predicted = useSessionStore.getState().queuedMessages.filter(isPredicted);
  for (const row of predicted) {
    if (named.has(row.text) && row.bubble) stash(row.text, row.bubble);
  }
  const survivors = predicted.filter((row) => !named.has(row.text));
  return [
    ...snapshot,
    ...survivors.map((row, i) => ({ ...row, position: snapshot.length + i + 1 })),
  ];
}
