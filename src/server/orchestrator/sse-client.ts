/**
 * Minimal SSE client using raw http.request.
 * Extracted from container-session-runner.ts for single-responsibility.
 */

import http from "node:http";

export interface SSEEvent {
  type: string;
  data: string;
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
): { close: () => void } {
  const parsedUrl = new URL(url);
  let destroyed = false;

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

      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => {
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
        if (!destroyed) onClose();
      });

      res.on("error", (err) => {
        if (!destroyed) onError(err);
      });
    },
  );

  req.on("error", (err) => {
    if (!destroyed) onError(err);
  });

  req.end();

  return {
    close: () => {
      destroyed = true;
      req.destroy();
    },
  };
}
