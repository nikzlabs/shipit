import type { WsPresentStateMessage } from "../../../server/shared/types.js";
import { usePresentStore } from "../../stores/present-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handlePresentState: Handler<WsPresentStateMessage> = (_ctx, data) => {
  const currentSessionId = useSessionStore.getState().sessionId;
  if (data.sessionId && currentSessionId && data.sessionId !== currentSessionId) {
    return;
  }
  usePresentStore.getState().hydrate(
    data.presentations.map((p) => ({
      presentId: p.presentId,
      mimeType: p.mimeType,
      createdAt: p.createdAt,
      filePath: p.filePath,
      ...(p.title !== undefined ? { title: p.title } : {}),
      ...(p.inline ? { inline: true } : {}),
    })),
  );
};
