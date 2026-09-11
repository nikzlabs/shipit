import type { WsBugReportFailed } from "../../../server/shared/types.js";
import { useBugReportStore } from "../../stores/bug-report-store.js";
import type { Handler } from "./types.js";

export const handleBugReportFailed: Handler<WsBugReportFailed> = (_ctx, data) => {
  useBugReportStore.getState().setFailed(data.cardId, data.message, data.scopeError);
};
