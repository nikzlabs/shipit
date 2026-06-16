import type { WsPrNotableFiles } from "../../../server/shared/types.js";
import { usePrStore } from "../../stores/pr-store.js";
import type { Handler } from "./types.js";

/**
 * docs/210 — patch the PR card's changed-docs strip from a post-turn refresh.
 * Merges the recomputed list into the live card without disturbing the
 * poller-owned fields, so the strip tracks docs changed across the whole PR.
 */
export const handlePrNotableFiles: Handler<WsPrNotableFiles> = (_ctx, data) => {
  usePrStore.getState().setNotableFiles(data.sessionId, data.cardId, data.notableFiles);
};
