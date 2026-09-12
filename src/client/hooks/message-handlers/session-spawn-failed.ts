import type { WsSessionSpawnFailed } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

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
