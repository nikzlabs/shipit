import type { WsPresentInlineCard } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handlePresentInlineCard: Handler<WsPresentInlineCard> = (_ctx, data) => {
  const session = useSessionStore.getState();
  if (session.messages.some((m) => m.presentInline?.presentId === data.card.presentId)) return;

  session.setMessages((prev) =>
    prev.some((m) => m.presentInline?.presentId === data.card.presentId)
      ? prev
      : [...prev, { role: "assistant" as const, text: "", presentInline: data.card }],
  );
};
