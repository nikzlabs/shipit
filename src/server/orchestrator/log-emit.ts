import type { WsLogAppend, WsServerMessage, LogSource } from "../shared/types.js";

export function agentLogAppend(source: LogSource, text: string): WsLogAppend {
  return {
    type: "log_append",
    channel: "agent",
    records: [{ ts: new Date().toISOString(), source, text }],
  };
}

interface LogEmitTarget {
  sessionId: string;
  emitMessage: (msg: WsServerMessage) => void;
}

export function appendAgentLog(
  broadcastLog: ((sessionId: string, source: LogSource, text: string) => void) | undefined,
  sessionId: string,
  runner: LogEmitTarget | null | undefined,
  source: LogSource,
  text: string,
): void {
  broadcastLog?.(sessionId, source, text);
  runner?.emitMessage(agentLogAppend(source, text));
}
