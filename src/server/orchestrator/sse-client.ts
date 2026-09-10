import http from "node:http";
import { workerAuthHeaders } from "./worker-auth.js";

export interface SSEEvent {
  type: string;
  data: string;
  /** Worker event ID for reconnect replay via ?since=. */
  seq?: number;
}

export interface ConnectSSEOpts {
  /** Must exceed the server's keepalive interval to detect half-open connections. */
  idleTimeoutMs?: number;
  /** Includes keepalive comments discarded by the event parser. */
  onActivity?: () => void;
}

export function connectSSE(
  url: string,
  onEvent: (event: SSEEvent) => void,
  onError: (err: Error) => void,
  onClose: () => void,
  onOpen?: () => void,
  opts?: ConnectSSEOpts,
): { close: () => void } {
  const parsedUrl = new URL(url);
  let destroyed = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const clearIdle = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const armIdle = (): void => {
    if (!opts?.idleTimeoutMs) return;
    clearIdle();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (destroyed) return;
      destroyed = true;
      try { req.destroy(); } catch { /* already destroyed */ }
      onError(new Error("SSE stream stale (no activity within idle timeout)"));
    }, opts.idleTimeoutMs);
  };

  const req = http.request(
    {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method: "GET",
      headers: { Accept: "text/event-stream", ...workerAuthHeaders(parsedUrl.origin) },
    },
    (res) => {
      let buffer = "";
      let currentEvent = "";
      let currentData = "";
      let currentSeq: number | undefined;

      if (onOpen) onOpen();
      armIdle();

      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => {
        armIdle();
        opts?.onActivity?.();

        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            currentData = line.slice(6);
          } else if (line.startsWith("id: ")) {
            const parsed = Number.parseInt(line.slice(4).trim(), 10);
            currentSeq = Number.isFinite(parsed) ? parsed : undefined;
          } else if (line === "") {
            if (currentEvent && currentData) {
              onEvent({ type: currentEvent, data: currentData, ...(currentSeq !== undefined ? { seq: currentSeq } : {}) });
            }
            currentEvent = "";
            currentData = "";
            currentSeq = undefined;
          }
        }
      });

      res.on("end", () => {
        clearIdle();
        if (!destroyed) onClose();
      });

      res.on("error", (err) => {
        clearIdle();
        if (!destroyed) onError(err);
      });
    },
  );

  req.on("error", (err) => {
    clearIdle();
    if (!destroyed) onError(err);
  });

  req.end();

  return {
    close: () => {
      destroyed = true;
      clearIdle();
      req.destroy();
    },
  };
}
