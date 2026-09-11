import type { WsSessionStarted } from "../../../server/shared/types.js";
import type { Handler } from "./types.js";

export const handleSessionStarted: Handler<WsSessionStarted> = (_ctx, _data) => {
  // intentionally empty — kept to preserve message-type coverage
};
