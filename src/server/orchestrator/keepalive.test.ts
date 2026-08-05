import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  KEEPALIVE_INTERVAL_MS,
  KEEPALIVE_MAX_MISSED_PONGS,
  SSE_KEEPALIVE_COMMENT,
  startSseKeepalive,
  startWebSocketKeepalive,
  type KeepaliveSocket,
} from "./keepalive.js";

/**
 * The whole point of this module is that a browser connection never sits idle
 * long enough for a reverse proxy to cut it, so the bound that matters is
 * "well under Cloudflare's 100s". These tests pin the ping cadence, the
 * half-open termination, and — most importantly — that both timers stop when
 * the connection ends (a leaked interval would ping a dead socket forever).
 */

/** Cloudflare's documented idle cut for proxied WebSockets and SSE streams. */
const CLOUDFLARE_IDLE_CUT_MS = 100_000;

function fakeSocket(readyState = 1): KeepaliveSocket & {
  pings: number;
  terminated: boolean;
  firePong: () => void;
  readyState: number;
} {
  let pongListener: (() => void) | undefined;
  return {
    readyState,
    pings: 0,
    terminated: false,
    on(_event: "pong", listener: () => void) {
      pongListener = listener;
      return this;
    },
    ping() { this.pings++; },
    terminate() { this.terminated = true; },
    firePong() { pongListener?.(); },
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("keepalive timings", () => {
  it("pings well inside the proxy idle cut, with room for missed intervals", () => {
    // Two missed intervals must still land inside the cut, otherwise a single
    // dropped ping would let the proxy kill an otherwise healthy connection.
    expect(KEEPALIVE_INTERVAL_MS * 3).toBeLessThan(CLOUDFLARE_IDLE_CUT_MS);
  });
});

describe("startWebSocketKeepalive", () => {
  it("pings on every interval while the socket is open", () => {
    const socket = fakeSocket();
    startWebSocketKeepalive(socket);

    vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS * 3);

    expect(socket.pings).toBe(3);
    expect(socket.terminated).toBe(false);
  });

  it("does not ping a socket that is not OPEN", () => {
    const socket = fakeSocket(0 /* CONNECTING */);
    startWebSocketKeepalive(socket);

    vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS * 3);

    expect(socket.pings).toBe(0);
  });

  it("keeps pinging indefinitely while pongs come back", () => {
    const socket = fakeSocket();
    startWebSocketKeepalive(socket);

    for (let i = 0; i < KEEPALIVE_MAX_MISSED_PONGS * 4; i++) {
      vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS);
      socket.firePong();
    }

    expect(socket.terminated).toBe(false);
    expect(socket.pings).toBe(KEEPALIVE_MAX_MISSED_PONGS * 4);
  });

  it("terminates a half-open socket after the missed-pong budget", () => {
    const socket = fakeSocket();
    const onUnresponsive = vi.fn();
    startWebSocketKeepalive(socket, { onUnresponsive });

    // Budget spent but not exceeded — still alive.
    vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS * KEEPALIVE_MAX_MISSED_PONGS);
    expect(socket.terminated).toBe(false);
    expect(socket.pings).toBe(KEEPALIVE_MAX_MISSED_PONGS);

    vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS);
    expect(socket.terminated).toBe(true);
    expect(onUnresponsive).toHaveBeenCalledOnce();
    // Termination replaces the ping, it doesn't accompany it.
    expect(socket.pings).toBe(KEEPALIVE_MAX_MISSED_PONGS);
  });

  it("a single pong resets the missed-pong budget", () => {
    const socket = fakeSocket();
    startWebSocketKeepalive(socket);

    vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS * KEEPALIVE_MAX_MISSED_PONGS);
    socket.firePong();
    vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS * KEEPALIVE_MAX_MISSED_PONGS);

    expect(socket.terminated).toBe(false);
  });

  it("stops pinging once the returned stop function runs", () => {
    const socket = fakeSocket();
    const stop = startWebSocketKeepalive(socket);

    vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS);
    stop();
    vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS * 10);

    expect(socket.pings).toBe(1);
    expect(socket.terminated).toBe(false);
  });

  it("survives a ping that throws mid-close", () => {
    const socket = fakeSocket();
    socket.ping = () => { throw new Error("WebSocket is not open"); };
    startWebSocketKeepalive(socket);

    expect(() => vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS * 2)).not.toThrow();
  });
});

describe("startSseKeepalive", () => {
  it("writes a comment line on every interval", () => {
    const writes: string[] = [];
    const client = { closed: false, write: (d: string) => writes.push(d) };
    startSseKeepalive(client);

    vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS * 2);

    expect(writes).toEqual([SSE_KEEPALIVE_COMMENT, SSE_KEEPALIVE_COMMENT]);
  });

  it("writes a comment, not an event — EventSource must ignore it", () => {
    // A `:`-prefixed line is a comment per the SSE spec; anything else here
    // would surface as a spurious message on the client.
    expect(SSE_KEEPALIVE_COMMENT.startsWith(":")).toBe(true);
    expect(SSE_KEEPALIVE_COMMENT.endsWith("\n\n")).toBe(true);
    expect(SSE_KEEPALIVE_COMMENT).not.toContain("event:");
    expect(SSE_KEEPALIVE_COMMENT).not.toContain("data:");
  });

  it("does not write to a closed client", () => {
    const writes: string[] = [];
    const client = { closed: true, write: (d: string) => writes.push(d) };
    startSseKeepalive(client);

    vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS * 3);

    expect(writes).toEqual([]);
  });

  it("stops writing once the returned stop function runs", () => {
    const writes: string[] = [];
    const client = { closed: false, write: (d: string) => writes.push(d) };
    const stop = startSseKeepalive(client);

    vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS);
    stop();
    vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS * 10);

    expect(writes).toHaveLength(1);
  });

  it("survives a write that throws on a vanished peer", () => {
    const client = { closed: false, write: () => { throw new Error("EPIPE"); } };
    startSseKeepalive(client);

    expect(() => vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS * 2)).not.toThrow();
  });
});
