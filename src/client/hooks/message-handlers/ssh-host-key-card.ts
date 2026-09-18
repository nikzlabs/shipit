import type { WsSshHostKeyCard } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleSshHostKeyCard: Handler<WsSshHostKeyCard> = (_ctx, data) => {
  const session = useSessionStore.getState();
  if (session.messages.some((m) => m.sshHostKey?.cardId === data.card.cardId)) return;

  session.setMessages((prev) =>
    prev.some((m) => m.sshHostKey?.cardId === data.card.cardId)
      ? prev
      : [...prev, { role: "assistant" as const, text: "", sshHostKey: data.card }],
  );
};
