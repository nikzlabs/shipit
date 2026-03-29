// ---- Interactive terminal types (client → server) ----

import type { EventEmitter } from "node:events";

/**
 * TerminalProcess — interface for the orchestrator to hold a reference to
 * a terminal without depending on the session-layer implementation.
 * The concrete class (using node-pty) lives in session/terminal.ts.
 */
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

export interface WsClearLogs {
  type: "clear_logs";
}

// ---- Interactive terminal types (server → client) ----

export interface WsTerminalOutput {
  type: "terminal_output";
  data: string;
}

export interface WsTerminalExit {
  type: "terminal_exit";
  exitCode: number | null;
}

/**
 * Server → Client: the SSE connection to the terminal worker dropped.
 * The orchestrator is attempting to reconnect. The client should display
 * a "reconnecting" indicator and expect buffered output to be replayed
 * once the connection is restored.
 */
export interface WsTerminalReconnecting {
  type: "terminal_reconnecting";
  /** Which reconnection attempt this is (1-based). */
  attempt: number;
  /** Maximum attempts before giving up. */
  maxAttempts: number;
}

// ---- Terminal/logs types ----

export interface WsLogEntry {
  type: "log_entry";
  /** Where the log line originated. */
  source: "stderr" | "stdout" | "server" | "preview" | "install";
  text: string;
  timestamp: string;
}
