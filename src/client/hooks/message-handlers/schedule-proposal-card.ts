import type {
  ScheduleProposalCard,
  WsScheduleProposalCard,
  WsScheduleProposalUpdate,
} from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/324-scheduled-sessions req 9 — the schedule proposal card. Idempotent by `cardId`, because
 * a reconnect replays the card over a transcript that already loaded it.
 */
export const handleScheduleProposalCard: Handler<WsScheduleProposalCard> = (_ctx, data) => {
  const session = useSessionStore.getState();
  if (session.messages.some((m) => m.scheduleProposal?.cardId === data.card.cardId)) return;
  session.setMessages((prev) =>
    prev.some((m) => m.scheduleProposal?.cardId === data.card.cardId)
      ? prev
      : [...prev, { role: "assistant" as const, text: "", scheduleProposal: data.card }],
  );
};

/** Also applied from a decision's HTTP response: with no runner, the server emits no update. */
export function applyScheduleProposalUpdate(cardId: string, card: ScheduleProposalCard): void {
  useSessionStore.getState().setMessages((prev) =>
    prev.map((m) => (m.scheduleProposal?.cardId === cardId ? { ...m, scheduleProposal: card } : m)),
  );
}

export const handleScheduleProposalUpdate: Handler<WsScheduleProposalUpdate> = (_ctx, data) => {
  applyScheduleProposalUpdate(data.cardId, data.card);
};
