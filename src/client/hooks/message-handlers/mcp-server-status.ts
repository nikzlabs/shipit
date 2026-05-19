import type { WsMcpServerStatus } from "../../../server/shared/types.js";
import { useMcpStore } from "../../stores/mcp-store.js";
import type { Handler } from "./types.js";

export const handleMcpServerStatus: Handler<WsMcpServerStatus> = (_ctx, data) => {
  useMcpStore.getState().applyStatus(data.name, data.state, data.reason);
};
