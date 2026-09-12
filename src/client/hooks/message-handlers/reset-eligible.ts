import type { WsResetEligible } from "../../../server/shared/types.js";
import { usePrStore } from "../../stores/pr-store.js";
import type { Handler } from "./types.js";

export const handleResetEligible: Handler<WsResetEligible> = (_ctx, data) => {
  usePrStore.getState().setResetEligible(data.sessionId, data.eligible);
};
