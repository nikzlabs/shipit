import type { WsClientMessage } from "../types.js";
import type { HandlerContext } from "./types.js";
import { TerminalProcess } from "../terminal.js";

type WsTerminalInput = Extract<WsClientMessage, { type: "terminal_input" }>;
type WsTerminalResize = Extract<WsClientMessage, { type: "terminal_resize" }>;

export function handleTerminalStart(ctx: HandlerContext): void {
  if (!ctx.getTerminal()) {
    const terminal = new TerminalProcess();
    terminal.on("data", (data: string) => {
      ctx.send({ type: "terminal_output", data });
    });
    terminal.on("exit", (code: number | null) => {
      ctx.send({ type: "terminal_exit", exitCode: code });
      ctx.setTerminal(null);
    });
    terminal.start(ctx.getActiveDir());
    ctx.setTerminal(terminal);
  }
}

export function handleTerminalInput(ctx: HandlerContext, msg: WsTerminalInput): void {
  const terminal = ctx.getTerminal();
  if (terminal) {
    terminal.write(msg.data);
  }
}

export function handleTerminalResize(ctx: HandlerContext, msg: WsTerminalResize): void {
  const terminal = ctx.getTerminal();
  if (terminal) {
    const cols = typeof msg.cols === "number" ? Math.max(1, Math.min(500, msg.cols)) : 80;
    const rows = typeof msg.rows === "number" ? Math.max(1, Math.min(200, msg.rows)) : 24;
    terminal.resize(cols, rows);
  }
}

export function handleClearLogs(ctx: HandlerContext): void {
  ctx.clearLogBuffer();
}
