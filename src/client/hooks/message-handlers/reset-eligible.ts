import type { WsResetEligible } from "../../../server/shared/types.js";
import { usePrStore } from "../../stores/pr-store.js";
import type { Handler } from "./types.js";

// docs/295 — this must NOT touch the composer's tick state. The composer once
// re-armed on the control's visibility, so a single `eligible: false` here —
// and `computeResetEligibility` fails closed on a git read — would re-tick a
// box the user had turned off. The untick belongs to the message being
// composed; only that message leaving clears it.
export const handleResetEligible: Handler<WsResetEligible> = (_ctx, data) => {
  usePrStore.getState().setResetEligible(data.sessionId, data.eligible);
};
