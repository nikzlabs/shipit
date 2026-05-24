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
 * instead of (or in addition to) any text content. Same "not persisted in
 * chat history" caveat — the card is informational, the shim's stderr
 * already records the failure for the agent.
 */
export const handleSessionSpawnFailed: Handler<WsSessionSpawnFailed> = (_ctx, data) => {
  const session = useSessionStore.getState();
  session.setMessages((prev) => [
    ...prev,
    {
      role: "assistant" as const,
      text: "",
      spawnFailed: {
        message: data.message,
        statusCode: data.statusCode,
        reason: data.reason,
        ...(data.title ? { title: data.title } : {}),
        ...(data.branch ? { branch: data.branch } : {}),
        ...(data.promptPreview ? { promptPreview: data.promptPreview } : {}),
        failedAt: data.failedAt,
      },
    },
  ]);
};
