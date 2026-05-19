import type { WsServiceLog } from "../../../server/shared/types.js";
import { useTerminalStore } from "../../stores/terminal-store.js";
import type { Handler } from "./types.js";

export const handleServiceLog: Handler<WsServiceLog> = (_ctx, data) => {
  useTerminalStore.getState().addEntry({ source: "preview", text: `[${data.name}] ${data.text}`, timestamp: new Date().toISOString() });
};
