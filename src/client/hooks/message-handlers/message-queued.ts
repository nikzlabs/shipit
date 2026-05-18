import type { WsMessageQueued } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleMessageQueued: Handler<WsMessageQueued> = (ctx, data) => {
  const session = useSessionStore.getState();
  const queued = data;
  session.setQueuedMessages((prev) => [...prev, { text: queued.text, position: queued.position }]);
  // Remove the optimistically-added message from the conversation and stash it.
  // The message will be re-inserted at the correct position (after the completed
  // assistant turn) when it is dequeued for execution via queue_updated.
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
