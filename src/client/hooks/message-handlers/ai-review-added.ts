import type { WsAiReviewAdded } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/203 — the parent agent recorded (or re-reviewed) a plain-text AI review.
 * Render it as an inline `ReviewCard` carrying the full `AiReviewCard` payload.
 * The card has no separate store; the payload lives on the message and a history
 * reload rehydrates it verbatim via `loadSessionHistory`.
 *
 * UPSERT by `reviewId`: the first `submit_review` appends the card; the parent's
 * re-review re-emits the SAME reviewId with patched markdown (and `reReviewed`),
 * which replaces the existing card in place rather than appending a duplicate.
 * The same keying makes a turn-event-buffer replay on reconnect idempotent — a
 * card delivered twice (history reload + buffer) collapses to one.
 */
export const handleAiReviewAdded: Handler<WsAiReviewAdded> = (_ctx, data) => {
  useSessionStore.getState().setMessages((prev) => {
    const idx = prev.findIndex((m) => m.aiReview?.reviewId === data.card.reviewId);
    if (idx === -1) {
      return [...prev, { role: "assistant" as const, text: "", aiReview: data.card }];
    }
    const next = prev.slice();
    next[idx] = { ...next[idx], aiReview: data.card };
    return next;
  });
};
