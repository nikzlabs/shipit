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

// ---- Unified log transport (docs/192) ----
//
// One channel-keyed message set serves BOTH the agent-container "Logs" tab
// (`channel: "agent"`) and every preview-service log panel
// (`channel: "service:<name>"`), replacing the old split vocabulary
// (`log_entry`/`clear_logs` + `service_log`/`service_log_buffer`/
// `subscribe_service_logs`). A single durable `LogStore` backs both channels;
// a single `<LogView>` renders both.

/** Where an agent-channel log line originated. Omitted on service records. */
export type LogSource = "stderr" | "stdout" | "server" | "preview" | "install";

/**
 * The common log record. Agent records carry `source` (so the renderer can
 * prefix + color them); service records omit `source` and carry a raw
 * `docker compose logs -f` chunk verbatim in `text` (ANSI preserved).
 */
export interface WsLogRecord {
  /** ISO timestamp. Empty string for raw service chunks that have no per-line ts. */
  ts: string;
  source?: LogSource;
  text: string;
}

/**
 * In-memory ring entry kept by `createLogBuffer` as a hot cache for the
 * diagnostics endpoint (docs/124). NOT a wire message — the durable replay
 * source is the `LogStore`; this is just the synchronous tail diagnostics
 * reads. Serialized verbatim into the diagnostics HTTP payload.
 */
export interface LogRingEntry {
  source: LogSource;
  text: string;
  timestamp: string;
}

// ---- client → server ----

/**
 * Subscribe to a log channel's backlog. The server replies with one
 * `log_snapshot` for the channel; live lines then arrive as `log_append`.
 * `<LogView>` sends this on mount (and the agent channel is also re-seeded
 * proactively on every WS (re)connect).
 */
export interface WsSubscribeLogs {
  type: "subscribe_logs";
  /** "agent" | `service:${name}` */
  channel: string;
}

/** Clear a channel's durable backlog (the agent Logs tab "Clear" action). */
export interface WsLogClear {
  type: "log_clear";
  channel: string;
}

// ---- server → client ----

/** Full backlog for a channel — RESETS the client model (replace, not append). */
export interface WsLogSnapshot {
  type: "log_snapshot";
  channel: string;
  records: WsLogRecord[];
}

/** Incremental live lines for a channel — appended to the client model. */
export interface WsLogAppend {
  type: "log_append";
  channel: string;
  records: WsLogRecord[];
}
