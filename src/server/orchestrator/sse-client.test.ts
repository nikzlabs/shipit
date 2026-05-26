/**
 * Tests for the minimal SSE client.
 *
 * Focus areas:
 * - Normal event parsing.
 * - `idleTimeoutMs`: connection treated as silently dead when no bytes
 *   arrive in time.
 * - `onActivity`: fires for every chunk, including server keepalive
 *   comments that the parser would otherwise discard.
 * - Explicit `close()` clears the idle timer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { connectSSE } from "./sse-client.js";

// ---------------------------------------------------------------------------
// Test SSE server helpers
// ---------------------------------------------------------------------------

interface TestServer {
  url: string;
  send: (chunk: string) => void;
  close: () => Promise<void>;
  /** Number of clients currently connected to /events. */
  clientCount: () => number;
  /** Resolve when the first client connects. */
  waitForClient: () => Promise<http.ServerResponse>;
}

async function startTestServer(): Promise<TestServer> {
  let activeRes: http.ServerResponse | null = null;
  let resolveFirstClient: ((res: http.ServerResponse) => void) | null = null;
  const firstClient = new Promise<http.ServerResponse>((resolve) => {
    resolveFirstClient = resolve;
  });
  let connectedCount = 0;

  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    // Flush headers immediately by writing an SSE comment. Without this,
    // Node buffers headers until the first body write, so a server that
    // wants to test "connection idle from the start" never actually
    // hands the client a response. Real workers do the same — see
    // `session-worker.ts` writing `: connected\n\n` on connect.
    res.write(": connected\n\n");
    activeRes = res;
    connectedCount++;
    if (resolveFirstClient) {
      resolveFirstClient(res);
      resolveFirstClient = null;
    }
    res.on("close", () => {
      connectedCount = Math.max(0, connectedCount - 1);
      if (activeRes === res) activeRes = null;
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no server address");
  const url = `http://127.0.0.1:${addr.port}/events`;

  return {
    url,
    send: (chunk: string) => {
      if (!activeRes) throw new Error("no active SSE client");
      activeRes.write(chunk);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (activeRes) {
          try { activeRes.end(); } catch { /* ignore */ }
        }
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
    clientCount: () => connectedCount,
    waitForClient: () => firstClient,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("connectSSE", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it("parses event/data pairs and invokes onEvent", async () => {
    const events: { type: string; data: string }[] = [];
    const opened = vi.fn();

    const conn = connectSSE(
      server.url,
      (e) => events.push(e),
      () => { /* no error */ },
      () => { /* no close */ },
      opened,
    );

    await server.waitForClient();
    server.send("event: hello\ndata: {\"a\":1}\n\n");
    server.send("event: world\ndata: ping\n\n");

    await waitFor(() => events.length === 2);

    expect(opened).toHaveBeenCalled();
    expect(events).toEqual([
      { type: "hello", data: "{\"a\":1}" },
      { type: "world", data: "ping" },
    ]);

    conn.close();
  });

  it("parses the id: line into event.seq when present", async () => {
    const events: { type: string; data: string; seq?: number }[] = [];

    const conn = connectSSE(
      server.url,
      (e) => events.push(e),
      () => { /* no error */ },
      () => { /* no close */ },
    );

    await server.waitForClient();
    // Worker sends `id:` before each event so reconnects can pass `?since=N`
    server.send("id: 1\nevent: agent_event\ndata: {\"k\":\"v\"}\n\n");
    server.send("id: 42\nevent: agent_done\ndata: {\"exitCode\":0}\n\n");

    await waitFor(() => events.length === 2);

    expect(events).toEqual([
      { type: "agent_event", data: "{\"k\":\"v\"}", seq: 1 },
      { type: "agent_done", data: "{\"exitCode\":0}", seq: 42 },
    ]);

    conn.close();
  });

  it("invokes onActivity on every chunk, including keepalive comments", async () => {
    const events: { type: string; data: string }[] = [];
    const onActivity = vi.fn();

    const conn = connectSSE(
      server.url,
      (e) => events.push(e),
      () => { /* no error */ },
      () => { /* no close */ },
      undefined,
      { onActivity },
    );

    await server.waitForClient();
    // Server keepalive comment — parser would normally drop it
    server.send(": keepalive\n\n");
    await waitFor(() => onActivity.mock.calls.length >= 1);
    expect(events).toHaveLength(0);

    server.send("event: tick\ndata: 1\n\n");
    await waitFor(() => events.length === 1);
    expect(onActivity.mock.calls.length).toBeGreaterThanOrEqual(2);

    conn.close();
  });

  it("fires onError with a stale error when no bytes arrive within idleTimeoutMs", async () => {
    const errors: Error[] = [];

    const conn = connectSSE(
      server.url,
      () => { /* no event */ },
      (err) => errors.push(err),
      () => { /* no close */ },
      undefined,
      { idleTimeoutMs: 100 },
    );

    await server.waitForClient();
    // Don't send anything — wait for the idle timer to fire.
    await waitFor(() => errors.length === 1, 1000);

    expect(errors[0].message).toMatch(/stale/i);

    conn.close();
  });

  it("resets the idle timer on every chunk (keepalive prevents stale)", async () => {
    const errors: Error[] = [];
    const events: { type: string; data: string }[] = [];

    const conn = connectSSE(
      server.url,
      (e) => events.push(e),
      (err) => errors.push(err),
      () => { /* no close */ },
      undefined,
      { idleTimeoutMs: 200 },
    );

    await server.waitForClient();

    // Send keepalives every 80ms for 400ms total — the idle timer is 200ms,
    // so each keepalive should reset it before it fires.
    const keepaliveInterval = setInterval(() => {
      try { server.send(": keepalive\n\n"); } catch { /* server closed */ }
    }, 80);

    await new Promise((resolve) => setTimeout(resolve, 400));
    clearInterval(keepaliveInterval);

    expect(errors).toHaveLength(0);
    expect(events).toHaveLength(0);

    conn.close();
  });

  it("close() clears the idle timer (no spurious error after close)", async () => {
    const errors: Error[] = [];

    const conn = connectSSE(
      server.url,
      () => { /* no event */ },
      (err) => errors.push(err),
      () => { /* no close */ },
      undefined,
      { idleTimeoutMs: 100 },
    );

    await server.waitForClient();

    // Close immediately — the idle timer should be cleared.
    conn.close();

    // Wait longer than idleTimeoutMs to be sure no error fires.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(errors).toHaveLength(0);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}
