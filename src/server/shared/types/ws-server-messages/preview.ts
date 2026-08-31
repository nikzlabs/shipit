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
