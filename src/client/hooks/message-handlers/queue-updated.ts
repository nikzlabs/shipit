import type { WsQueueUpdated } from "../../../server/shared/types.js";
import type { ChatMessage } from "../../components/MessageList.js";
import { useSessionStore } from "../../stores/session-store.js";
import { applyQueueSnapshot } from "../../utils/predicted-queue.js";
import type { Handler } from "./types.js";

export const handleQueueUpdated: Handler<WsQueueUpdated> = (ctx, data) => {
  const session = useSessionStore.getState();
  const update = data;
  // A snapshot confirms a predicted row or says nothing about it; either way it
  // must not throw away the composed bubble the restore below reads back.
  session.setQueuedMessages(
    applyQueueSnapshot(update.queue, (text, bubble) => ctx.queuedMessageStash.set(text, bubble)),
  );
  if (update.dequeued) {

    const stashed = ctx.queuedMessageStash.get(update.dequeued);
    ctx.queuedMessageStash.delete(update.dequeued);
    const restoredMsg: ChatMessage = stashed
      ? { ...stashed, queued: false, queuePosition: undefined }
      : { role: "user" as const, text: update.dequeued };
    session.setMessages((prev) => [...prev, restoredMsg]);
  }

  const remainingTexts = new Set(update.queue.map((q) => q.text));
  for (const key of ctx.queuedMessageStash.keys()) {
    if (!remainingTexts.has(key)) {
      ctx.queuedMessageStash.delete(key);
    }
  }
};
