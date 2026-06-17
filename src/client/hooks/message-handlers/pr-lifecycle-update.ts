import type { WsPrLifecycleUpdate } from "../../../server/shared/types.js";
import { usePrStore } from "../../stores/pr-store.js";
import type { Handler } from "./types.js";

export const handlePrLifecycleUpdate: Handler<WsPrLifecycleUpdate> = (_ctx, data) => {
  usePrStore.getState().updateCard(data.sessionId, {
    cardId: data.cardId,
    phase: data.phase,
    headBranch: data.headBranch,
    files: data.files,
    totalInsertions: data.totalInsertions,
    totalDeletions: data.totalDeletions,
    pr: data.pr,
    checks: data.checks,
    autoMerge: data.autoMerge,
    errorMessage: data.errorMessage,
    previousMergedPr: data.previousMergedPr,
  });
  // docs/210 — the changed-docs strip lives in its own session-keyed slice, not
  // on the card. The ready/open emits carry notableFiles only when non-empty
  // (the server omits the field otherwise), so route it through when present and
  // leave the last-known list untouched on omit; the authoritative clear path is
  // the standalone `pr_notable_files` patch.
  if (data.notableFiles) {
    usePrStore.getState().setNotableFiles(data.sessionId, data.cardId, data.notableFiles);
  }
};
