import type { WsPresentClearedMessage } from "../../../server/shared/types.js";
import { usePresentStore } from "../../stores/present-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handlePresentCleared: Handler<WsPresentClearedMessage> = (_ctx, data) => {
  const currentSessionId = useSessionStore.getState().sessionId;
  if (data.sessionId && currentSessionId && data.sessionId !== currentSessionId) {
    return;
  }
  usePresentStore.getState().clear(data.presentId);
};
