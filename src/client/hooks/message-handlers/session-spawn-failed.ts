import type { WsSessionSpawnFailed } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/117 cross-cutting follow-up — render a `SpawnFailedCard` inline in
 * the parent's chat when the running agent's `shipit session create` was
 * rejected by the orchestrator.
 *
 * Mirrors `handleSessionSpawned`: append a new assistant `ChatMessage`
 * carrying `spawnFailed` metadata; `MessageList` knows to render the card
 * instead of (or in addition to) any text content. Persisted in chat history
 * (recorded in-band via `emitChatCard`) so it survives a session switch / full
 * reload — and unlike a successful spawn there is no sidebar row to fall back
 * on, so this card is the only record of the failure. Idempotent by the
 * server-generated `id` so a reconnect buffer-replay doesn't double-render.
 */
export const handleSessionSpawnFailed: Handler<WsSessionSpawnFailed> = (_ctx, data) => {
  const session = useSessionStore.getState();
  if (session.messages.some((m) => m.spawnFailed?.id === data.id)) return;
  session.setMessages((prev) =>
    prev.some((m) => m.spawnFailed?.id === data.id)
      ? prev
      : [
          ...prev,
          {
            role: "assistant" as const,
            text: "",
            spawnFailed: {
              id: data.id,
              message: data.message,
              statusCode: data.statusCode,
              reason: data.reason,
              ...(data.title ? { title: data.title } : {}),
              ...(data.promptPreview ? { promptPreview: data.promptPreview } : {}),
              ...(data.shipitSource ? { shipitSource: true } : {}),
              failedAt: data.failedAt,
            },
          },
        ],
  );
};
