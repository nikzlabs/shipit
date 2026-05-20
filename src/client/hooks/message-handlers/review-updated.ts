import type { WsReviewUpdated } from "../../../server/shared/types.js";
import { useFileReviewStore } from "../../stores/file-review-store.js";
import type { Handler } from "./types.js";

/**
 * docs/125 — the chat-native review subagent wrote anchored comments via the
 * `submit_review_comments` tool; the server broadcast the updated draft. Merge
 * it into the store so an open file-preview modal renders the new comments live.
 */
export const handleReviewUpdated: Handler<WsReviewUpdated> = (_ctx, data) => {
  useFileReviewStore.getState().applyReviewUpdate(data.review);
};
