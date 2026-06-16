export interface WsPreviewStatus {
  type: "preview_status";
  running: boolean;
  port: number;
  url: string;
  /** How the preview server was identified: "vite" (bundled), "managed" (command mode), "detected" (port scan), or omitted. */
  source?: "vite" | "managed" | "detected";
  /** All ports detected by the port scanner (non-Vite dev servers). */
  detectedPorts?: number[];
  /** Non-null when the preview server crashed. Contains the process exit code. */
  exitCode?: number | null;
  /** Last lines of preview output captured before the crash. */
  errorOutput?: string;
  /** Session that owns this preview — client discards stale messages during session switching. */
  sessionId?: string;
}

/**
 * Server → Client: the per-session preview proxy could not reach the
 * compose-managed container on the requested port (connection refused,
 * EHOSTUNREACH, HMR upgrade socket destroyed, etc).
 *
 * Today, proxy errors only manifest as a 502 JSON body inside the iframe
 * or an empty WebSocket disconnect — neither of which is observable from
 * the orchestrator's side and neither of which gives the user actionable
 * feedback. This message lets the PreviewFrame overlay an explicit
 * banner and routes a record into the Logs panel.
 *
 * See docs/124-session-rescue-and-diagnostics §1.5.
 */
export interface WsPreviewError {
  type: "preview_error";
  sessionId: string;
  /** Port the proxy was attempting to reach. */
  port: number;
  /** Short human-readable reason (e.g. "Connection refused", "HMR upgrade failed"). */
  message: string;
  /** Whether the failure was on the WebSocket-upgrade path (HMR) or plain HTTP. */
  upgrade?: boolean;
}
