import type { WsEgressPromptCard, WsEgressPromptResolved } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useEgressPromptStore } from "../../stores/egress-prompt-store.js";
import type { Handler } from "./types.js";

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

export const handleEgressPromptResolved: Handler<WsEgressPromptResolved> = (_ctx, data) => {
  useEgressPromptStore.getState().setPhase(data.cardId, data.phase);
};
