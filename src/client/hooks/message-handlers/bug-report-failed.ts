import type { WsBugReportFailed } from "../../../server/shared/types.js";
import { useBugReportStore } from "../../stores/bug-report-store.js";
import type { Handler } from "./types.js";

/**
 * docs/164 — terminal failure: surface the error on the card and drop it back
 * to an editable draft so the user can fix their token / edit the body and
 * resubmit.
 */
export const handleBugReportFailed: Handler<WsBugReportFailed> = (_ctx, data) => {
  useBugReportStore.getState().setFailed(data.cardId, data.message, data.scopeError);
};
