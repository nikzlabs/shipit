import type { WsSystemNotice } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

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
