import type { WsSessionMemoryExhausted } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleSessionMemoryExhausted: Handler<WsSessionMemoryExhausted> = (_ctx, data) => {
  // Agent-container OOM circuit breaker tripped on the server. The
  // server has stopped recreating containers until the user explicitly
  // opts back in. Show a banner in the SessionHealthStrip with the
  // retry path; the same trip is also written to the per-session log
  // ring and lastCreateError (defense-in-depth — a reconnecting viewer
  // still sees it via either of those channels).
  if (data.sessionId === useSessionStore.getState().sessionId) {
    useSessionStore.getState().setMemoryExhausted({
      countInWindow: data.countInWindow,
      windowMs: data.windowMs,
      threshold: data.threshold,
      at: Date.now(),
    });
  }
};
