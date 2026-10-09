import type {
  ScheduleNotesAccessCard,
  WsScheduleNotesAccessCard,
  WsScheduleNotesAccessUpdate,
} from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/324-scheduled-sessions reqs 28, 30 — the notes access card. Idempotent by `cardId`, because
 * a reconnect replays the card over a transcript that already loaded it.
 */
export const handleScheduleNotesAccessCard: Handler<WsScheduleNotesAccessCard> = (_ctx, data) => {
  const session = useSessionStore.getState();
  if (session.messages.some((m) => m.scheduleNotesAccess?.cardId === data.card.cardId)) return;
  session.setMessages((prev) =>
    prev.some((m) => m.scheduleNotesAccess?.cardId === data.card.cardId)
      ? prev
      : [...prev, { role: "assistant" as const, text: "", scheduleNotesAccess: data.card }],
  );
};

/** Also applied from a decision's HTTP response: with no runner, the server emits no update. */
export function applyScheduleNotesAccessUpdate(cardId: string, card: ScheduleNotesAccessCard): void {
  useSessionStore.getState().setMessages((prev) =>
    prev.map((m) => (m.scheduleNotesAccess?.cardId === cardId ? { ...m, scheduleNotesAccess: card } : m)),
  );
}

export const handleScheduleNotesAccessUpdate: Handler<WsScheduleNotesAccessUpdate> = (_ctx, data) => {
  applyScheduleNotesAccessUpdate(data.cardId, data.card);
};
