import type { WsMessageSteered } from "../../../server/shared/types.js";
import type { ChatMessage } from "../../components/MessageList.js";
import { useSessionStore } from "../../stores/session-store.js";
import { restorePredictedQueueEntries } from "../../utils/predicted-queue.js";
import { fillUserBubble } from "./user-bubble.js";
import type { Handler } from "./types.js";

export const handleMessageSteered: Handler<WsMessageSteered> = (ctx, data) => {
  const id = data.clientRequestId;
  // A steer feeds the message into the running process, so a row predicting it
  // would WAIT in a queue was wrong. Restoring it puts its bubble, with this id,
  // in the transcript, where the match below finds it.
  restorePredictedQueueEntries(id);
  ctx.queuedMessageStash.delete(id);

  // By id, never by text: an earlier message with the same text is another
  // bubble (planning#691). Every viewer gets the event's attachments.
  const fields = {
    images: data.images,
    files: data.files,
    uploadPaths: data.uploadPaths,
    agentInterface: data.agentInterface,
    messageOrigin: data.messageOrigin,
  };
  useSessionStore.getState().setMessages((prev) => {
    const index = prev.findIndex((m) => m.role === "user" && m.clientRequestId === id);
    if (index === -1) {
      const bubble: ChatMessage = fillUserBubble({ role: "user", text: data.text, clientRequestId: id }, fields);
      return [...prev, bubble];
    }
    const next = prev.slice();
    next[index] = fillUserBubble(prev[index], fields);
    return next;
  });
};
