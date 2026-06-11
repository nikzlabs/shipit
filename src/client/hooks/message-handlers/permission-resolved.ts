import type { WsPermissionResolved } from "../../../server/shared/types.js";
import { usePermissionStore } from "../../stores/permission-store.js";
import type { Handler } from "./types.js";

/**
 * docs/193 — terminal state for a permission-request card. Swap the card to
 * approved / denied / expired. Driven by the broker's resolution broadcast, so
 * it fires for a user decision, a timeout, and a turn teardown alike.
 */
export const handlePermissionResolved: Handler<WsPermissionResolved> = (_ctx, data) => {
  usePermissionStore.getState().setResolved(data.requestId, data.phase, data.remembered);
};
