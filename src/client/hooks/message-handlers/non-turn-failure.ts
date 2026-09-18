import type { WsNonTurnFailureCard, WsNonTurnFailureDismissed } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleNonTurnFailureCard: Handler<WsNonTurnFailureCard> = (_ctx, data) => {
  const session = useSessionStore.getState();
  if (session.messages.some((m) => m.nonTurnFailure?.cardId === data.card.cardId)) return;
  session.setMessages((prev) =>
    prev.some((m) => m.nonTurnFailure?.cardId === data.card.cardId)
      ? prev
      : [
          ...prev,
          {
            role: "assistant" as const,
            text: "",
            nonTurnFailure: {
              cardId: data.card.cardId,
              purpose: data.card.purpose,
              ...(data.card.serviceId ? { serviceId: data.card.serviceId } : {}),
              ...(data.card.serviceName ? { serviceName: data.card.serviceName } : {}),
              ...(data.card.billingMode ? { billingMode: data.card.billingMode } : {}),
              ...(data.card.modelId ? { modelId: data.card.modelId } : {}),
              ...(data.card.pinned ? { pinned: true } : {}),
              fallback: data.card.fallback,
              ...(data.card.detail ? { detail: data.card.detail } : {}),
              createdAt: data.card.createdAt,
              ...(data.card.dismissedAt ? { dismissedAt: data.card.dismissedAt } : {}),
            },
          },
        ],
  );
};

export const handleNonTurnFailureDismissed: Handler<WsNonTurnFailureDismissed> = (_ctx, data) => {
  useSessionStore.getState().setMessages((prev) =>
    prev.map((m) =>
      m.nonTurnFailure?.cardId === data.cardId
        ? { ...m, nonTurnFailure: { ...m.nonTurnFailure, dismissedAt: data.dismissedAt } }
        : m,
    ),
  );
};
