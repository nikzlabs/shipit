import type { WsSessionStarted } from "../../../server/shared/types.js";
import type { Handler } from "./types.js";

// session_list is now delivered via SSE (useServerEvents hook)
// No-op: session_started is handled elsewhere.
export const handleSessionStarted: Handler<WsSessionStarted> = (_ctx, _data) => {
  // intentionally empty — kept to preserve message-type coverage
};
