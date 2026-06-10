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
 * The card is persisted in chat history (recorded in-band on the server via
 * `emitChatCard`), so it survives a session switch / full reload, not just a
 * WS reconnect. Idempotent by `childSessionId`: the card is both persisted and
 * buffered into the turn-event log, so a reconnect can deliver it twice (once
 * from `loadSessionHistory`, once from the buffer replay) — skip the duplicate.
 */
export const handleSessionSpawned: Handler<WsSessionSpawned> = (_ctx, data) => {
  const session = useSessionStore.getState();
  if (session.messages.some((m) => m.spawnedSession?.childSessionId === data.childSessionId)) return;
  session.setMessages((prev) =>
    prev.some((m) => m.spawnedSession?.childSessionId === data.childSessionId)
      ? prev
      : [
          ...prev,
          {
            role: "assistant" as const,
            text: "",
            spawnedSession: {
              childSessionId: data.childSessionId,
              title: data.title,
              ...(data.branch ? { branch: data.branch } : {}),
              spawnedAt: data.spawnedAt,
              ...(data.shipitFix ? { shipitFix: data.shipitFix } : {}),
            },
          },
        ],
  );
};
