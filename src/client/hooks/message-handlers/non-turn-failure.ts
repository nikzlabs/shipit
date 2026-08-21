import type { WsNonTurnFailureCard, WsNonTurnFailureDismissed } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/252 phase 7 (req 9) — render the notice that ShipIt's non-turn work
 * (naming this session, writing its pull-request description) failed.
 *
 * The card is BOTH persisted in chat history and buffered into the turn-event
 * log, so a reconnect can deliver it twice (once from `loadSessionHistory`,
 * once from the buffer replay) — dedupe by the stable `cardId`. That durability
 * is the requirement, not an implementation detail: naming is fire-and-forget
 * and routinely finishes with the user on another session, so a card that
 * vanished with the tab would be silent in exactly the case req 9 exists for.
 */
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

/**
 * docs/252 phase 7 — the notice was dismissed (here or in another attached
 * viewer). Patches the row rather than removing it, matching what the server
 * persists: the record of the failure outlives the acknowledgement.
 */
export const handleNonTurnFailureDismissed: Handler<WsNonTurnFailureDismissed> = (_ctx, data) => {
  useSessionStore.getState().setMessages((prev) =>
    prev.map((m) =>
      m.nonTurnFailure?.cardId === data.cardId
        ? { ...m, nonTurnFailure: { ...m.nonTurnFailure, dismissedAt: data.dismissedAt } }
        : m,
    ),
  );
};
