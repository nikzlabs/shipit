export interface WsPreviewStatus {
  type: "preview_status";
  running: boolean;
  port: number;
  url: string;
  source?: "vite" | "managed" | "detected";
  detectedPorts?: number[];
  exitCode?: number | null;
  errorOutput?: string;
  sessionId?: string;
}
