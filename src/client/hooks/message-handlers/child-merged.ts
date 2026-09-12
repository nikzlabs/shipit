import type { WsChildMergedCard } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleChildMergedCard: Handler<WsChildMergedCard> = (_ctx, data) => {
  const session = useSessionStore.getState();
  if (session.messages.some((m) => m.childMerged?.cardId === data.card.cardId)) return;
  session.setMessages((prev) =>
    prev.some((m) => m.childMerged?.cardId === data.card.cardId)
      ? prev
      : [
          ...prev,
          {
            role: "assistant" as const,
            text: "",
            childMerged: {
              cardId: data.card.cardId,
              childSessionId: data.card.childSessionId,
              childTitle: data.card.childTitle,
              ...(data.card.branch ? { branch: data.card.branch } : {}),
              outcome: data.card.outcome,
              prNumber: data.card.prNumber,
              prUrl: data.card.prUrl,
              ...(data.card.prTitle ? { prTitle: data.card.prTitle } : {}),
              ...(data.card.mergeSha ? { mergeSha: data.card.mergeSha } : {}),
              ...(data.card.deliveryFailure ? { deliveryFailure: data.card.deliveryFailure } : {}),
              createdAt: data.card.createdAt,
            },
          },
        ],
  );
};
