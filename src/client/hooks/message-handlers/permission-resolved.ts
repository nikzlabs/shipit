import type { WsPermissionResolved } from "../../../server/shared/types.js";
import { usePermissionStore } from "../../stores/permission-store.js";
import type { Handler } from "./types.js";

export const handlePermissionResolved: Handler<WsPermissionResolved> = (_ctx, data) => {
  usePermissionStore.getState().setResolved(data.requestId, data.phase, data.remembered);
};
