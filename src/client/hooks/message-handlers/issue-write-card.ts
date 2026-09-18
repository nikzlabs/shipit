import type { WsIssueWriteCard } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useIssueWriteStore } from "../../stores/issue-write-store.js";
import type { Handler } from "./types.js";

export const handleIssueWriteCard: Handler<WsIssueWriteCard> = (_ctx, data) => {
  useIssueWriteStore.getState().upsertCard(data.card);

  const session = useSessionStore.getState();
  if (session.messages.some((m) => m.issueWrite?.cardId === data.card.cardId)) return;

  session.setMessages((prev) =>
    prev.some((m) => m.issueWrite?.cardId === data.card.cardId)
      ? prev
      : [
          ...prev,
          {
            role: "assistant" as const,
            text: "",
            issueWrite: { cardId: data.card.cardId },
          },
        ],
  );
};
