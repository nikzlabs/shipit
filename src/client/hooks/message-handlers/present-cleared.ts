import type { WsPresentClearedMessage } from "../../../server/shared/types.js";
import { usePresentStore } from "../../stores/present-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/093 — drop a single presentation (LRU eviction from the worker buffer)
 * or wipe the whole list (session switch, full clear). `presentId` undefined
 * means "clear everything".
 */
export const handlePresentCleared: Handler<WsPresentClearedMessage> = (_ctx, data) => {
  const currentSessionId = useSessionStore.getState().sessionId;
  if (data.sessionId && currentSessionId && data.sessionId !== currentSessionId) {
    return;
  }
  usePresentStore.getState().clear(data.presentId);
};
