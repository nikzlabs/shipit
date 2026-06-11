import type { WsPermissionResolved } from "../../../server/shared/types.js";
import { usePermissionStore } from "../../stores/permission-store.js";
import type { Handler } from "./types.js";

/**
 * docs/193 — terminal state for a permission-request card. Swap the card to
 * approved / denied, driven by the broker's resolution broadcast when the user
 * answers. (There is no timeout/expiry — an unanswered card stays pending.)
 */
export const handlePermissionResolved: Handler<WsPermissionResolved> = (_ctx, data) => {
  usePermissionStore.getState().setResolved(data.requestId, data.phase, data.remembered);
};
