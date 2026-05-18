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
    errorMessage: data.errorMessage,
  });
};
