import type { WsSystemNotice } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/138 — render a system note inline. Unlike `error`, this does NOT touch
 * the loading state, so it's safe mid-turn (a guarded-mode fallback notice
 * fires on `agent_init`, while the turn keeps running).
 *
 * Notices are now persisted to chat history (so they survive a full reload, not
 * just a WS reconnect). Idempotent by `noticeId`: a notice is both persisted and
 * buffered into the turn-event log, so a reconnect can deliver it twice (once
 * from `loadSessionHistory`, once from the buffer replay) — skip the duplicate.
 * Transient rewind action-feedback notices carry no `id` and aren't persisted;
 * they append unconditionally (they live for the rewind interaction only).
 */
export const handleSystemNotice: Handler<WsSystemNotice> = (_ctx, data) => {
  const session = useSessionStore.getState();
  if (data.id && session.messages.some((m) => m.noticeId === data.id)) return;
  session.setMessages((prev) =>
    data.id && prev.some((m) => m.noticeId === data.id)
      ? prev
      : [
          ...prev,
          {
            role: "assistant" as const,
            text: data.message,
            notice: true,
            noticeLevel: data.level ?? "info",
            ...(data.id ? { noticeId: data.id } : {}),
          },
        ],
  );
};
