import type { WsClientMessage } from "../../shared/types.js";
import type { ConnectionCtx, RunnerCtx } from "./types.js";
import type { ContainerSessionRunner } from "../container-session-runner.js";

type WsTerminalStart = Extract<WsClientMessage, { type: "terminal_start" }>;
type WsTerminalInput = Extract<WsClientMessage, { type: "terminal_input" }>;
type WsTerminalResize = Extract<WsClientMessage, { type: "terminal_resize" }>;

function isContainerRunner(runner: unknown): runner is ContainerSessionRunner {
  return !!runner && typeof (runner as ContainerSessionRunner).startTerminalOnWorker === "function";
}

export async function handleTerminalStart(ctx: ConnectionCtx & RunnerCtx, msg: WsTerminalStart): Promise<void> {
  const runner = ctx.getRunner();
  if (!runner) return;

  if (!isContainerRunner(runner)) {
    ctx.send({ type: "error", message: "Terminal requires a container-backed session" });
    return;
  }

  if (!runner.remoteTerminalRunning) {
    await runner.startTerminalOnWorker(msg.cols, msg.rows);
  } else {
    // Terminal already running — replay buffered output for this viewer
    const buffered = runner.getTerminalOutputBuffer();
    if (buffered) {
      ctx.send({ type: "terminal_output", data: buffered });
    }
  }
}

export async function handleTerminalInput(ctx: RunnerCtx, msg: WsTerminalInput): Promise<void> {
  const runner = ctx.getRunner();
  if (!runner || !isContainerRunner(runner)) return;

  await runner.writeTerminalOnWorker(msg.data);
}

export async function handleTerminalResize(ctx: RunnerCtx, msg: WsTerminalResize): Promise<void> {
  const runner = ctx.getRunner();
  if (!runner || !isContainerRunner(runner)) return;

  const cols = typeof msg.cols === "number" ? Math.max(1, Math.min(500, msg.cols)) : 80;
  const rows = typeof msg.rows === "number" ? Math.max(1, Math.min(200, msg.rows)) : 24;
  await runner.resizeTerminalOnWorker(cols, rows);
}

export function handleClearLogs(ctx: ConnectionCtx & RunnerCtx): void {
  ctx.clearLogBuffer();
  // Also clear the runner's terminal output buffer
  const runner = ctx.getRunner();
  if (runner) {
    runner.clearTerminalOutputBuffer();
  }
}
