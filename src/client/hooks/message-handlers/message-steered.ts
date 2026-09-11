import type { WsMessageSteered } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleMessageSteered: Handler<WsMessageSteered> = (_ctx, data) => {
  const session = useSessionStore.getState();

  const messages = session.messages;
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  if (lastUserMsg?.text === data.text) {
    if (data.messageOrigin && !lastUserMsg.messageOrigin) {
      session.setMessages((prev) => prev.map((message) =>
        message === lastUserMsg ? { ...message, messageOrigin: data.messageOrigin } : message
      ));
    }
    return;
  }
  session.setMessages((prev) => [
    ...prev,
    {
      role: "user" as const,
      text: data.text,
      images: data.images,
      files: data.files,
      uploadPaths: data.uploadPaths,
      agentInterface: data.agentInterface,
      messageOrigin: data.messageOrigin,
    },
  ]);
};
