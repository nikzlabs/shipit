export const KEEPALIVE_INTERVAL_MS = 30_000;
export const KEEPALIVE_MAX_MISSED_PONGS = 3;

export const SSE_KEEPALIVE_COMMENT = ": keepalive\n\n";

export interface KeepaliveSocket {
  readyState: number;
  on(event: "pong", listener: () => void): unknown;
  ping(): void;
  terminate(): void;
}

export interface KeepaliveSseClient {
  write(data: string): unknown;
  closed: boolean;
}

// Browsers answer protocol pings automatically. Call the returned stop function on close.
export function startWebSocketKeepalive(
  socket: KeepaliveSocket,
  opts: {
    intervalMs?: number;
    maxMissedPongs?: number;
    onUnresponsive?: () => void;
  } = {},
): () => void {
  const intervalMs = opts.intervalMs ?? KEEPALIVE_INTERVAL_MS;
  const maxMissedPongs = opts.maxMissedPongs ?? KEEPALIVE_MAX_MISSED_PONGS;

  let missedPongs = 0;
  socket.on("pong", () => { missedPongs = 0; });

  const timer = setInterval(() => {
    if (socket.readyState !== 1) return;
    if (missedPongs >= maxMissedPongs) {
      opts.onUnresponsive?.();
      socket.terminate();
      return;
    }
    missedPongs++;
    try {
      socket.ping();
    } catch {
      // The close handler stops this timer.
    }
  }, intervalMs);
  unrefTimer(timer);

  return () => clearInterval(timer);
}

// SSE comments reset proxy idle timers without emitting events. Stop on request close.
export function startSseKeepalive(
  client: KeepaliveSseClient,
  opts: { intervalMs?: number } = {},
): () => void {
  const intervalMs = opts.intervalMs ?? KEEPALIVE_INTERVAL_MS;
  const timer = setInterval(() => {
    if (client.closed) return;
    try {
      client.write(SSE_KEEPALIVE_COMMENT);
    } catch {
      // The request close handler stops this timer.
    }
  }, intervalMs);
  unrefTimer(timer);
  return () => clearInterval(timer);
}

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  if (typeof timer === "object" && typeof timer.unref === "function") timer.unref();
}
