import type { WsSessionPrStatus } from "../../../server/shared/types.js";
import { usePrStore } from "../../stores/pr-store.js";
import type { Handler } from "./types.js";

export const handleSessionPrStatus: Handler<WsSessionPrStatus> = (_ctx, data) => {
  usePrStore.getState().applyPrStatusUpdates([data.status]);
};
