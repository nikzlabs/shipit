import type { WsSessionForked } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleSessionForked: Handler<WsSessionForked> = (_ctx, data) => {
  const { sessionName } = data;
  // Add a notification-style message in current chat
  useSessionStore.getState().setMessages((prev) => [
    ...prev,
    {
      role: "assistant" as const,
      text: `Session forked as "${sessionName}". Switch to it from the sidebar.`,
      streaming: false,
    },
  ]);
};
