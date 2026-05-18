import type { WsTerminalExit } from "../../../server/shared/types.js";
import { useTerminalStore } from "../../stores/terminal-store.js";
import type { Handler } from "./types.js";

export const handleTerminalExit: Handler<WsTerminalExit> = (_ctx, _data) => {
  useTerminalStore.getState().setShellStarted(false);
};
