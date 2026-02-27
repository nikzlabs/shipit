// ---- Interactive terminal types (client → server) ----

export interface WsTerminalStart {
  type: "terminal_start";
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

export interface WsPreviewError {
  type: "preview_error";
  message: string;
  stack?: string;
  source?: string;
  line?: number;
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

// ---- Terminal/logs types ----

export interface WsLogEntry {
  type: "log_entry";
  /** Where the log line originated. */
  source: "stderr" | "stdout" | "server" | "preview" | "deploy" | "install";
  text: string;
  timestamp: string;
}
