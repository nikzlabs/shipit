import type { WsBugReportDismissed } from "../../../server/shared/types.js";
import { useBugReportStore } from "../../stores/bug-report-store.js";
import type { Handler } from "./types.js";

/**
 * nikzlabs/shipit#2350 — terminal decline: collapse the card for every attached viewer,
 * not just the one that clicked Cancel. The store guards a `filed` card, so a
 * replayed dismissal can never undo a success.
 */
export const handleBugReportDismissed: Handler<WsBugReportDismissed> = (_ctx, data) => {
  useBugReportStore.getState().setDismissed(data.cardId);
};
