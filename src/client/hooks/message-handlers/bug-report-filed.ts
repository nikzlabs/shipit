import type { WsBugReportFiled } from "../../../server/shared/types.js";
import { useBugReportStore } from "../../stores/bug-report-store.js";
import type { Handler } from "./types.js";

export const handleBugReportFiled: Handler<WsBugReportFiled> = (_ctx, data) => {
  useBugReportStore.getState().setFiled(data.cardId, data.number, data.url);
};
