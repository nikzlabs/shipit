import type { WsSessionPrStatus } from "../../../server/shared/types.js";
import { usePrStore } from "../../stores/pr-store.js";
import type { Handler } from "./types.js";

/**
 * Fills a gap only: the two channels share no ordering, so a live SSE
 * `pr_status` that got here first is newer than this attach-time read.
 */
export const handleSessionPrStatus: Handler<WsSessionPrStatus> = (_ctx, data) => {
  if (usePrStore.getState().statusBySession[data.sessionId]) return;
  usePrStore.getState().applyPrStatusUpdates([data.status]);
};
