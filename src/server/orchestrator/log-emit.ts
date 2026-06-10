import type { WsLogAppend, WsServerMessage, LogSource } from "../shared/types.js";

/**
 * Unified agent-channel log emit (docs/192).
 *
 * Build a `log_append` for the agent channel. One envelope for every producer
 * so the live line renders through the same `<LogView channel="agent">` that
 * the durable snapshot seeds.
 */
export function agentLogAppend(source: LogSource, text: string): WsLogAppend {
  return {
    type: "log_append",
    channel: "agent",
    records: [{ ts: new Date().toISOString(), source, text }],
  };
}

/** Minimal runner surface needed to emit a live log line to attached viewers. */
interface LogEmitTarget {
  sessionId: string;
  emitMessage: (msg: WsServerMessage) => void;
}

/**
 * Persist an agent-channel log line to the durable backlog + in-memory ring
 * (via `broadcastLog`) AND emit it live as a `log_append`. This is the single
 * choke point that replaces the old dual-send (`broadcastLog(...)` followed by
 * a hand-built `emitMessage({ type: "log_entry" })`) repeated across producers
 * — every line now both survives a reconnect/restart and renders live.
 *
 * `sessionId` is taken explicitly so a line still persists when no viewer is
 * attached (e.g. a container-exit notice). `runner` is optional for the same
 * reason — when absent, the line is persisted but not emitted live.
 */
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
