import type { WsSystemNotice } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/138 — render a guarded-mode system note inline. Unlike `error`, this
 * does NOT touch the loading state, so it's safe mid-turn (a guarded-mode
 * fallback notice fires on `agent_init`, while the turn keeps running).
 */
export const handleSystemNotice: Handler<WsSystemNotice> = (_ctx, data) => {
  const session = useSessionStore.getState();
  session.setMessages((prev) => [
    ...prev,
    {
      role: "assistant" as const,
      text: data.message,
      notice: true,
      noticeLevel: data.level ?? "info",
    },
  ]);
};
