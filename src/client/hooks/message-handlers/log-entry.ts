import type { WsLogEntry } from "../../../server/shared/types.js";
import { useTerminalStore } from "../../stores/terminal-store.js";
import type { Handler } from "./types.js";

export const handleLogEntry: Handler<WsLogEntry> = (_ctx, data) => {
  useTerminalStore.getState().addEntry({ source: data.source, text: data.text, timestamp: data.timestamp });
};
