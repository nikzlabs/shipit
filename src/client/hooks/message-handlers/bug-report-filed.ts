import type { WsBugReportFiled } from "../../../server/shared/types.js";
import { useBugReportStore } from "../../stores/bug-report-store.js";
import type { Handler } from "./types.js";

/** docs/164 — terminal success: swap the card to its "Filed — #N" state. */
export const handleBugReportFiled: Handler<WsBugReportFiled> = (_ctx, data) => {
  useBugReportStore.getState().setFiled(data.cardId, data.number, data.url);
};
