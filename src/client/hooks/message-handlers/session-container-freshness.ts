import type { WsSessionContainerFreshness } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleSessionContainerFreshness: Handler<WsSessionContainerFreshness> = (_ctx, data) => {
  useSessionStore.getState().setContainerFreshness(data.freshness);
};
