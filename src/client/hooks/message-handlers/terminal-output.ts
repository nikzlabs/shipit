import type { WsTerminalOutput } from "../../../server/shared/types.js";
import type { Handler } from "./types.js";

export const handleTerminalOutput: Handler<WsTerminalOutput> = (ctx, data) => {
  ctx.terminalRef.current?.write(data.data);
};
