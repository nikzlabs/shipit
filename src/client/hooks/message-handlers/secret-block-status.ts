import type { WsSecretBlockStatus } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleSecretBlockStatus: Handler<WsSecretBlockStatus> = (_ctx, data) => {
  useSessionStore.getState().setSecretBlock(data.block);
};
