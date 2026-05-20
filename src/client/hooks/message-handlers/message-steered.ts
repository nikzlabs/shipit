import type { WsMessageSteered } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * Live steering acknowledgement — the server echoes back a steered user message
 * so reconnecting viewers and other tabs see it in the turn event stream.
 *
 * The primary sender already inserted the message optimistically in handleSend,
 * so we skip adding it a second time if the last user message already matches.
 */
export const handleMessageSteered: Handler<WsMessageSteered> = (_ctx, data) => {
  const session = useSessionStore.getState();
  // Skip if the message is already shown (optimistic insert from the sender tab).
  const messages = session.messages;
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  if (lastUserMsg?.text === data.text) return;
  session.setMessages((prev) => [...prev, { role: "user" as const, text: data.text }]);
};
