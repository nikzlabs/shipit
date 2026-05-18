import type { WsClearLogs } from "../../../server/shared/types.js";
import { useTerminalStore } from "../../stores/terminal-store.js";
import type { Handler } from "./types.js";

export const handleClearLogs: Handler<WsClearLogs> = (_ctx, _data) => {
  useTerminalStore.getState().clearEntries();
};
