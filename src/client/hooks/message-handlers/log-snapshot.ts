import type { WsLogSnapshot } from "../../../server/shared/types.js";
import { useLogStore } from "../../stores/log-store.js";
import type { Handler } from "./types.js";

/** docs/192 — full backlog for a channel; replaces the LogView model wholesale. */
export const handleLogSnapshot: Handler<WsLogSnapshot> = (_ctx, data) => {
  useLogStore.getState().snapshot(data.channel, data.records);
};
