import type { WsSessionMemoryExhausted } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleSessionMemoryExhausted: Handler<WsSessionMemoryExhausted> = (_ctx, data) => {

  if (data.sessionId === useSessionStore.getState().sessionId) {
    useSessionStore.getState().setMemoryExhausted({
      countInWindow: data.countInWindow,
      windowMs: data.windowMs,
      threshold: data.threshold,
      at: Date.now(),
    });
  }
};
