/**
 * Keepalive for the two long-lived browser↔orchestrator connections: the
 * per-session WebSocket (`/ws/sessions/:id`) and the global SSE stream
 * (`/api/events`).
 *
 * Why this exists: reverse proxies terminate a connection that carries no
 * bytes for a while, and they do it silently. Cloudflare's proxy cuts an idle
 * WebSocket (and an idle `text/event-stream`) at **100 seconds** of no data in
 * either direction. A ShipIt session sitting between turns sends nothing at
 * all — no agent events, no status changes — so behind Cloudflare the socket
 * dies roughly every 100s. The browser then reconnects on backoff and re-runs
 * the whole attach burst (`loadSessionHistory`, `turn_snapshot`, compose
 * replay, `preview_status`), which surfaces as a preview flicker plus an
 * endless stream of `[ws] session client connected/disconnected` pairs in the
 * orchestrator log.
 *
 * Neither connection had any keepalive. The orchestrator↔worker SSE hop
 * already did (`sse-client.ts`); this closes the same gap on the browser hop.
 *
 * Not covered here: the preview reverse proxy's WebSocket leg
 * (`preview-proxy.ts`), which is a raw byte pipe between the browser and the
 * dev server — injecting frames into it could interleave mid-frame and corrupt
 * the stream. Vite's HMR client pings on its own every 30s, so that leg keeps
 * itself alive; a dev server that doesn't ping would still be cut.
 */

/**
 * 30s is comfortably under the 100s cut with room for two missed intervals,
 * and is cheap: a WebSocket ping frame is 2 bytes, an SSE comment is 13.
 */
export const KEEPALIVE_INTERVAL_MS = 30_000;

/**
 * Consecutive unanswered pings before a session WebSocket is considered dead
 * and terminated. Browsers answer a protocol-level ping with a pong
 * automatically, so silence across this many intervals (90s) means the peer is
 * gone — a half-open TCP connection that no `close` event will ever report.
 *
 * Terminating one is safe and is *not* a WebSocket-lifecycle side effect in
 * the sense CLAUDE.md forbids: it produces exactly the `close` event a real
 * disconnect produces, and that handler only calls `detachFromRunner()`.
 * Leaving the socket open is the harmful option — it holds a viewer reference
 * forever, keeping the PR/release pollers ungated for a viewer that left.
 */
export const KEEPALIVE_MAX_MISSED_PONGS = 3;

/** SSE comment line that resets a proxy's idle timer without being parsed as an event. */
export const SSE_KEEPALIVE_COMMENT = ": keepalive\n\n";

/** The slice of `ws`'s WebSocket this module needs — keeps the unit test fake small. */
export interface KeepaliveSocket {
  readyState: number;
  on(event: "pong", listener: () => void): unknown;
  ping(): void;
  terminate(): void;
}

/** The slice of the SSE client record this module needs. */
export interface KeepaliveSseClient {
  write(data: string): unknown;
  closed: boolean;
}

/**
 * Start protocol-level pings on a session WebSocket, terminating it once
 * {@link KEEPALIVE_MAX_MISSED_PONGS} pings go unanswered.
 *
 * Protocol pings rather than an app-level message: browsers answer them
 * automatically, so this needs no client change and never reaches the
 * `WsClientMessage` union.
 *
 * Returns a stop function — call it from the socket's `close` handler.
 */
export function startWebSocketKeepalive(
  socket: KeepaliveSocket,
  opts: {
    intervalMs?: number;
    maxMissedPongs?: number;
    /** Called just before terminating an unresponsive socket (logging hook). */
    onUnresponsive?: () => void;
  } = {},
): () => void {
  const intervalMs = opts.intervalMs ?? KEEPALIVE_INTERVAL_MS;
  const maxMissedPongs = opts.maxMissedPongs ?? KEEPALIVE_MAX_MISSED_PONGS;

  let missedPongs = 0;
  socket.on("pong", () => { missedPongs = 0; });

  const timer = setInterval(() => {
    // OPEN. A socket still CONNECTING or already CLOSING has nothing to keep
    // alive, and its close handler will stop us.
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
      // Socket closing underneath us — the close handler stops this timer.
    }
  }, intervalMs);
  unrefTimer(timer);

  return () => clearInterval(timer);
}

/**
 * Start writing SSE keepalive comments to a browser event stream. `EventSource`
 * ignores comment lines, but they are real bytes on the wire — which is what a
 * proxy's idle timer actually watches.
 *
 * Returns a stop function — call it from the request's `close` handler.
 */
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
      // Peer vanished between the flag check and the write; the request's
      // `close` handler stops this timer.
    }
  }, intervalMs);
  unrefTimer(timer);
  return () => clearInterval(timer);
}

/**
 * A keepalive must never be the reason the process (or a vitest worker) stays
 * alive — the connection it serves is what owns the event loop. Guarded rather
 * than cast because the ambient `setInterval` return type differs between the
 * Node and DOM libs.
 */
function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  if (typeof timer === "object" && typeof timer.unref === "function") timer.unref();
}
