import type { WsMessageQueued } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import { adoptPredictedQueueEntry } from "../../utils/predicted-queue.js";
import type { Handler } from "./types.js";

export const handleMessageQueued: Handler<WsMessageQueued> = (ctx, data) => {
  const session = useSessionStore.getState();
  const queued = data;

  // This browser may already be showing the message as queued, having predicted
  // the compaction that is now confirmed. Adopt that row rather than adding a
  // second one, and take its bubble for the stash the dequeue restores from —
  // the transcript never held it, so there is nothing to remove below.
  const predicted = adoptPredictedQueueEntry(queued.text, queued.position);
  if (predicted) {
    ctx.queuedMessageStash.set(queued.text, predicted);
    return;
  }

  session.setQueuedMessages((prev) => [...prev, { text: queued.text, position: queued.position }]);

  session.setMessages((prev) => {
    let targetIdx = -1;
    for (let i = prev.length - 1; i >= 0; i--) {
      if (prev[i]?.role === "user" && prev[i]?.text === queued.text) {
        targetIdx = i;
        break;
      }
    }
    if (targetIdx !== -1) {
      ctx.queuedMessageStash.set(queued.text, prev[targetIdx]);
      return [...prev.slice(0, targetIdx), ...prev.slice(targetIdx + 1)];
    }
    return prev;
  });
};
