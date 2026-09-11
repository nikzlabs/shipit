import type { WsVoiceNote } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import { autoplayVoiceNote } from "../../voice/voice-notes.js";
import type { Handler } from "./types.js";

export const handleVoiceNote: Handler<WsVoiceNote> = (_ctx, data) => {
  const session = useSessionStore.getState();

  if (session.messages.some((m) => m.voiceNote?.id === data.id)) return;

  session.setMessages((prev) =>
    prev.some((m) => m.voiceNote?.id === data.id)
      ? prev
      : [
          ...prev,
          {
            role: "assistant" as const,
            text: "",
            voiceNote: {
              id: data.id,
              headline: data.headline,
              kind: data.kind,
              createdAt: data.createdAt,
            },
          },
        ],
  );

  autoplayVoiceNote({ id: data.id, headline: data.headline });
};
