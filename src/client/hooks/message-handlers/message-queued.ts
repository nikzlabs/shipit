import type { WsMessageQueued } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import { adoptPredictedQueueEntry, placeQueueRow } from "../../utils/predicted-queue.js";
import type { Handler } from "./types.js";

export const handleMessageQueued: Handler<WsMessageQueued> = (ctx, data) => {
  const session = useSessionStore.getState();
  const row = { id: data.id, text: data.text, position: data.position };

  // This browser may already be showing the message as queued, having predicted
  // the compaction that is now confirmed. Adopt that row rather than adding a
  // second one, and take its bubble for the stash the dequeue restores from —
  // the transcript never held it, so there is nothing to remove below.
  const predicted = adoptPredictedQueueEntry(row);
  if (predicted) {
    ctx.queuedMessageStash.set(data.id, predicted);
    return;
  }

  session.setQueuedMessages((prev) => placeQueueRow(prev, row));

  // By id, never by text: on a viewer that did not send it, an older message with the same
  // text is a different message and stays where it is (planning#691).
  session.setMessages((prev) => {
    const index = prev.findIndex((m) => m.role === "user" && m.clientRequestId === data.id);
    if (index === -1) return prev;
    ctx.queuedMessageStash.set(data.id, prev[index]);
    return [...prev.slice(0, index), ...prev.slice(index + 1)];
  });
};
