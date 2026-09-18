import type { WsSessionSpawned } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

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
