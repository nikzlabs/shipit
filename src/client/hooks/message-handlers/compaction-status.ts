import type { WsCompactionStatus } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleCompactionStatus: Handler<WsCompactionStatus> = (_ctx, data) => {
  useSessionStore.getState().setCompacting(data.active);
};
