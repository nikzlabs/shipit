import type { WsLogAppend } from "../../../server/shared/types.js";
import { useLogStore } from "../../stores/log-store.js";
import type { Handler } from "./types.js";

export const handleLogAppend: Handler<WsLogAppend> = (_ctx, data) => {
  useLogStore.getState().append(data.channel, data.records);
};
