import type { WsSettingsProposalCard, WsSettingsProposalUpdate } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/299-agent-settings-access req 4 — the settings proposal card.
 *
 * Idempotent by `cardId`, because the same card arrives twice by design: it is
 * persisted in chat history AND buffered in the turn-event log, so a reconnect
 * replays it over a transcript that already loaded it. Appending on the replay
 * would show the user two copies of one proposal, each with its own Apply.
 *
 * There is no store to keep in step. The whole card rides on the message, so a
 * phase change is a patch of that row and nothing else.
 */
export const handleSettingsProposalCard: Handler<WsSettingsProposalCard> = (_ctx, data) => {
  const session = useSessionStore.getState();
  if (session.messages.some((m) => m.settingsProposal?.cardId === data.card.cardId)) return;
  session.setMessages((prev) =>
    prev.some((m) => m.settingsProposal?.cardId === data.card.cardId)
      ? prev
      : [...prev, { role: "assistant" as const, text: "", settingsProposal: data.card }],
  );
};

export const handleSettingsProposalUpdate: Handler<WsSettingsProposalUpdate> = (_ctx, data) => {
  useSessionStore.getState().setMessages((prev) =>
    prev.map((m) =>
      m.settingsProposal?.cardId === data.cardId ? { ...m, settingsProposal: data.card } : m,
    ),
  );
};
