import type { WsRewindSnapshotAvailable } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleRewindSnapshotAvailable: Handler<WsRewindSnapshotAvailable> = (_ctx, data) => {
  useSessionStore.getState().setRewindRecovery({
    sessionId: data.sessionId,
    action: data.action,
    expiresAt: data.expiresAt,
  });
};
