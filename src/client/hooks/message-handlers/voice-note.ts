import type { WsVoiceNote } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import { announceVoiceNote } from "../../voice/voice-notes.js";
import type { Handler } from "./types.js";

/**
 * Plays a note the transcript does not hold yet. Called on arrival as well when
 * the note waits for a history load: the loaded transcript already holds it, so
 * the check after the load would never play it.
 */
export function announceArrivingVoiceNote(data: WsVoiceNote): void {
  if (useSessionStore.getState().messages.some((m) => m.voiceNote?.id === data.id)) return;
  announceVoiceNote({ id: data.id, headline: data.headline });
}

export const handleVoiceNote: Handler<WsVoiceNote> = (_ctx, data) => {
  const session = useSessionStore.getState();

  if (session.messages.some((m) => m.voiceNote?.id === data.id)) return;
  announceVoiceNote({ id: data.id, headline: data.headline });

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
};
