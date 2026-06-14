import type { WsEgressPromptCard, WsEgressPromptResolved } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useEgressPromptStore } from "../../stores/egress-prompt-store.js";
import type { Handler } from "./types.js";

/**
 * docs/172 / SHI-90 — the Tier C egress allow-once card. Seed the host into the
 * egress-prompt store (keyed by cardId so a later resolved update can swap it in
 * place) and append a marker chat message so it renders inline where the proxy
 * blocked the connection.
 *
 * Idempotent by cardId: the card is both persisted to chat history and buffered
 * into the turn-event log, so a reconnect can deliver it twice. Skip the
 * duplicate append; the store `upsertCard` is itself non-clobbering so it can't
 * reset a card already rehydrated to a resolved phase.
 */
export const handleEgressPromptCard: Handler<WsEgressPromptCard> = (_ctx, data) => {
  useEgressPromptStore.getState().upsertCard({ cardId: data.cardId, host: data.host });

  const session = useSessionStore.getState();
  if (session.messages.some((m) => m.egressPrompt?.cardId === data.cardId)) return;

  session.setMessages((prev) =>
    prev.some((m) => m.egressPrompt?.cardId === data.cardId)
      ? prev
      : [
          ...prev,
          {
            role: "assistant" as const,
            text: "",
            egressPrompt: { cardId: data.cardId, host: data.host },
          },
        ],
  );
};

/** docs/172 — terminal transition for an egress allow-once card. */
export const handleEgressPromptResolved: Handler<WsEgressPromptResolved> = (_ctx, data) => {
  useEgressPromptStore.getState().setPhase(data.cardId, data.phase);
};
