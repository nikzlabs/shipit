import type {
  WsSessionMessageProposalCard,
  WsSessionMessageProposalUpdate,
} from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleSessionMessageProposalCard: Handler<WsSessionMessageProposalCard> = (
  _ctx,
  data,
) => {
  useSessionStore.getState().setMessages((prev) =>
    prev.some((m) => m.sessionMessageProposal?.cardId === data.card.cardId)
      ? prev
      : [...prev, { role: "assistant" as const, text: "", sessionMessageProposal: data.card }],
  );
};

/**
 * Shared by the WS update and by the deliver request's own response. The
 * response path is load-bearing, not redundant: the route delivers even when
 * the proposing session has no runner, and with no runner it emits nothing at
 * all — so without this the card would fall back to its Send button after a
 * delivery that succeeded.
 */
export function applySessionMessageProposalUpdate(
  data: Omit<WsSessionMessageProposalUpdate, "type" | "sessionId">,
): void {
  useSessionStore.getState().setMessages((prev) => {
    const index = prev.findIndex((m) => m.sessionMessageProposal?.cardId === data.cardId);
    if (index < 0) return prev;
    const card = prev[index].sessionMessageProposal!;
    // `delivered` is terminal: a late `delivering` must never reopen it.
    if (card.state === "delivered" && data.state !== "delivered") return prev;
    const next = prev.slice();
    next[index] = {
      ...next[index],
      sessionMessageProposal: {
        ...card,
        state: data.state,
        ...(data.deliveredAt ? { deliveredAt: data.deliveredAt } : {}),
        ...(data.queued !== undefined ? { queued: data.queued } : {}),
        errorMessage: data.errorMessage,
      },
    };
    return next;
  });
}

export const handleSessionMessageProposalUpdate: Handler<WsSessionMessageProposalUpdate> = (
  _ctx,
  data,
) => applySessionMessageProposalUpdate(data);
