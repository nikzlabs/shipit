import type { WsRewindPreview } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleRewindPreview: Handler<WsRewindPreview> = (_ctx, data) => {
  useSessionStore.getState().setRewindPreview(data);
};
