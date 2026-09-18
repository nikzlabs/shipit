import type { EventEmitter } from "node:events";

export interface TerminalProcess extends EventEmitter {
  start(cwd: string, cols?: number, rows?: number): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  readonly running: boolean;
}

export interface WsTerminalStart {
  type: "terminal_start";
  cols?: number;
  rows?: number;
}

export interface WsTerminalInput {
  type: "terminal_input";
  data: string;
}

export interface WsTerminalResize {
  type: "terminal_resize";
  cols: number;
  rows: number;
}

export interface WsTerminalOutput {
  type: "terminal_output";
  data: string;
}

export interface WsTerminalExit {
  type: "terminal_exit";
  exitCode: number | null;
}

/** Buffered output replays when the worker connection returns. */
export interface WsTerminalReconnecting {
  type: "terminal_reconnecting";
  /** One-based. */
  attempt: number;
  maxAttempts: number;
}

export type LogSource = "stderr" | "stdout" | "server" | "preview" | "install";

/** Service records omit source and preserve raw chunks, including ANSI. */
export interface WsLogRecord {
  /** ISO timestamp; empty for untimestamped service chunks. */
  ts: string;
  source?: LogSource;
  text: string;
}

/** Diagnostics cache; LogStore owns durable replay. */
export interface LogRingEntry {
  source: LogSource;
  text: string;
  timestamp: string;
}

export interface WsSubscribeLogs {
  type: "subscribe_logs";
  /** "agent" or "service:<name>". */
  channel: string;
}

export interface WsLogClear {
  type: "log_clear";
  channel: string;
}

/** Replaces the client's backlog. */
export interface WsLogSnapshot {
  type: "log_snapshot";
  channel: string;
  records: WsLogRecord[];
}

export interface WsLogAppend {
  type: "log_append";
  channel: string;
  records: WsLogRecord[];
}
