import type { WsSystemUserMessage } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleSystemUserMessage: Handler<WsSystemUserMessage> = (_ctx, data) => {
  const session = useSessionStore.getState();
  session.setMessages((prev) => [...prev, { role: "user" as const, text: data.text }]);
  session.setIsLoading(true);
  if (data.activity) {
    session.setActivity({ label: data.activity });
  }
};
