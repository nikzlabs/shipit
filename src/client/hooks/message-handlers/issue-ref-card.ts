import type { WsIssueRefCard } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleIssueRefCard: Handler<WsIssueRefCard> = (_ctx, data) => {
  const session = useSessionStore.getState();
  if (session.messages.some((m) => m.issueRef?.cardId === data.card.cardId)) return;

  session.setMessages((prev) =>
    prev.some((m) => m.issueRef?.cardId === data.card.cardId)
      ? prev
      : [...prev, { role: "assistant" as const, text: "", issueRef: data.card }],
  );
};
