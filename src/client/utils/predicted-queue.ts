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
 * Every entry here is reconciled against the server, and only ever removed by a
 * server answer or by the send failing:
 *
 *  - the compaction runs → `message_queued` **adopts** the entry, taking its
 *    bubble for the stash that `queue_updated` restores the message from;
 *  - the compaction does not run → the turn's `system_user_message` echo
 *    carries this send's `clientRequestId`, and **drops** it (that handler then
 *    appends the bubble, as it does for a message it never rendered);
 *  - the frame never left the browser, or the send was refused → **dropped**.
 *
 * One owner for all three, because the entry is written in `send-user-message`
 * and read by three message handlers, and a row that only one of them knows how
 * to retire is a queue strip that never empties.
 */

import type { ChatMessage } from "../components/MessageList.js";
import { useSessionStore } from "../stores/session-store.js";

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

export function dropPredictedQueueEntry(requestId: string): void {
  const session = useSessionStore.getState();
  if (!session.queuedMessages.some((q) => q.requestId === requestId)) return;
  session.setQueuedMessages((prev) => prev.filter((q) => q.requestId !== requestId));
}

/**
 * The server has queued the message a prediction already put on screen. Hands
 * back the bubble the entry was holding so the caller can stash it for the
 * dequeue, and returns `null` when nothing predicted this message — which is
 * the signal to queue it the ordinary way.
 */
export function adoptPredictedQueueEntry(text: string, position: number): ChatMessage | null {
  const session = useSessionStore.getState();
  const predicted = session.queuedMessages.find(
    (q) => q.requestId !== undefined && q.text === text,
  );
  if (!predicted) return null;
  session.setQueuedMessages((prev) =>
    prev.map((q) => (q.requestId === predicted.requestId ? { text, position } : q)),
  );
  return predicted.bubble ?? null;
}
