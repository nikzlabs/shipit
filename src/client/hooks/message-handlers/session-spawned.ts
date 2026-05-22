import type { WsSessionSpawned } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/117 Phase 2 — render a `SpawnedSessionCard` inline in the parent's
 * chat when the running agent spawns a sibling session via the
 * `shipit session create` shim.
 *
 * The handler appends a new assistant ChatMessage carrying `spawnedSession`
 * metadata. `MessageList` knows to render the card instead of (or in
 * addition to) any text content. The card itself reads live session state
 * from `useSessionStore` so the status pill stays current without us having
 * to wire a stream of follow-up events.
 *
 * The card is intentionally NOT persisted in chat history in v1 — the child
 * remains visible in the sidebar after reload via the existing
 * `session_list` broadcast, so a missing card after refresh is not data
 * loss. Phase 3 (when `wait`/`message`/`archive` ship) can revisit persistence.
 */
export const handleSessionSpawned: Handler<WsSessionSpawned> = (_ctx, data) => {
  const session = useSessionStore.getState();
  session.setMessages((prev) => [
    ...prev,
    {
      role: "assistant" as const,
      text: "",
      spawnedSession: {
        childSessionId: data.childSessionId,
        title: data.title,
        ...(data.branch ? { branch: data.branch } : {}),
        spawnedAt: data.spawnedAt,
      },
    },
  ]);
};
