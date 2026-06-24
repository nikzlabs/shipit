import type { WsResetEligible } from "../../../server/shared/types.js";
import { usePrStore } from "../../stores/pr-store.js";
import type { Handler } from "./types.js";

/**
 * docs/218 — set the transient reset-eligibility signal for a session. Pushed on
 * session activation and after each turn; drives the composer's "start from the
 * latest base" control visibility (ANDed client-side with the
 * `autoResetMergedBranch` setting). Transient — recomputed on each (re)connect.
 */
export const handleResetEligible: Handler<WsResetEligible> = (_ctx, data) => {
  usePrStore.getState().setResetEligible(data.sessionId, data.eligible);
};
