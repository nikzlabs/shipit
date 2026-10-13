import type { WsQueueUpdated } from "../../../server/shared/types.js";
import type { ChatMessage } from "../../components/MessageList.js";
import { useSessionStore } from "../../stores/session-store.js";
import { applyQueueSnapshot } from "../../utils/predicted-queue.js";
import { offerReturnedMessages } from "../../utils/returned-messages.js";
import type { Handler } from "./types.js";

export const handleQueueUpdated: Handler<WsQueueUpdated> = (ctx, data) => {
  const session = useSessionStore.getState();
  // A snapshot confirms a predicted row or says nothing about it; either way it
  // must not throw away the composed bubble the restore below reads back.
  session.setQueuedMessages(
    applyQueueSnapshot(data.queue, (id, bubble) => ctx.queuedMessageStash.set(id, bubble)),
  );
  const dequeued = data.dequeued;
  if (dequeued) {
    const stashed = ctx.queuedMessageStash.get(dequeued.id);
    ctx.queuedMessageStash.delete(dequeued.id);
    // A viewer that did not send it gets the text now; the turn's echo adds the attachments.
    const restoredMsg: ChatMessage = stashed
      ? { ...stashed, queued: false, queuePosition: undefined, clientRequestId: dequeued.id }
      : { role: "user" as const, text: dequeued.text, clientRequestId: dequeued.id };
    // A reconnect replays this event over a transcript that can already hold the bubble.
    session.setMessages((prev) =>
      prev.some((m) => m.clientRequestId === dequeued.id) ? prev : [...prev, restoredMsg]);
  }

  if (data.returned) offerReturnedMessages(data.sessionId, data.returned);

  const remainingIds = new Set(data.queue.map((q) => q.id));
  for (const key of ctx.queuedMessageStash.keys()) {
    if (!remainingIds.has(key)) {
      ctx.queuedMessageStash.delete(key);
    }
  }
};
