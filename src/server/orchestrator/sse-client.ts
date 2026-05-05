/**
 * Minimal SSE client using raw http.request.
 * Extracted from container-session-runner.ts for single-responsibility.
 */

import http from "node:http";

export interface SSEEvent {
  type: string;
  data: string;
}

export interface ConnectSSEOpts {
  /**
   * If set, the connection is treated as silently dead when no bytes
   * arrive from the server within `idleTimeoutMs`. The request is
   * destroyed and `onError` fires with `Error("SSE stream stale (no
   * activity within idle timeout)")` — which then lets the caller's
   * existing reconnect path recover.
   *
   * Pair this with a server-side keepalive interval that is shorter
   * (e.g. server keepalive every 15s, client idle timeout 45s = three
   * missed keepalives). Without an idle timeout, half-open TCP
   * connections (NAT idle drops, kernel-killed peers, frozen worker
   * processes) appear "connected" indefinitely and never trigger
   * Node's `error`/`end` handlers.
   */
  idleTimeoutMs?: number;
  /**
   * Fires whenever any bytes arrive from the server, including SSE
   * comment lines (e.g. `: keepalive`) that the parser would otherwise
   * discard. Use this to advance liveness gauges that should reflect
   * connection health rather than only "the agent emitted an event."
   */
  onActivity?: () => void;
}

/**
 * Minimal SSE client using raw http.request. Avoids the EventSource polyfill
 * dependency. Parses "event:" and "data:" fields from the SSE stream.
 */
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
      path: parsedUrl.pathname,
      method: "GET",
      headers: { Accept: "text/event-stream" },
    },
    (res) => {
      let buffer = "";
      let currentEvent = "";
      let currentData = "";

      if (onOpen) onOpen();
      // Arm the idle timer once the response starts so even a worker
      // that connects but never writes is treated as stale.
      armIdle();

      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => {
        // Reset the idle timer on every byte from the server, including
        // keepalive comments. Without this, only fully-formed events
        // would advance liveness — which means an idle-but-healthy
        // connection looks the same as a dead one.
        armIdle();
        opts?.onActivity?.();

        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // Keep incomplete last line

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            currentData = line.slice(6);
          } else if (line === "") {
            // End of event
            if (currentEvent && currentData) {
              onEvent({ type: currentEvent, data: currentData });
            }
            currentEvent = "";
            currentData = "";
          }
          // Skip comments (lines starting with ":")
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
