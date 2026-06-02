import type { WsVoiceNote } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import { autoplayVoiceNote } from "../../voice/voice-notes.js";
import type { Handler } from "./types.js";

/**
 * docs/163 — the Native sink of a voice note. Append a `VoiceNoteCard` to the
 * chat transcript (distinct from the per-turn `PlayTurnButton`) and, when
 * hands-free mode is on and unlocked, autoplay the spoken headline.
 *
 * The card carries only the ear-shaped headline; the body stays on screen.
 * `needsAttention: false` notes render as a silent bubble (no autoplay).
 */
export const handleVoiceNote: Handler<WsVoiceNote> = (_ctx, data) => {
  const session = useSessionStore.getState();

  // Idempotent by id: the note is both persisted to chat history and buffered
  // into the turn-event log, so a reconnect can deliver it twice (once from
  // loadSessionHistory, once from the buffer replay). Skip the duplicate append
  // — and the re-autoplay — when a card with this id is already present.
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
              needsAttention: data.needsAttention,
              kind: data.kind,
              createdAt: data.createdAt,
            },
          },
        ],
  );

  autoplayVoiceNote({
    id: data.id,
    headline: data.headline,
    needsAttention: data.needsAttention,
  });
};
