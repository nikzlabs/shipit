/**
 * Tests for `SseConnectionManager.reconnectAttempts`.
 *
 * The counter itself is old — it drives the exponential backoff — but
 * docs/121 gap E promoted it to a *decision* input: the missing-container
 * reconciler reads it as "this worker has stopped answering" and, on a high
 * enough value, asks Docker whether the container is still alive. Two
 * properties have to hold for that gate to be safe, and neither is obvious
 * from the field's original purpose:
 *
 *   1. It climbs while the worker is unreachable, so a dead session
 *      eventually crosses the threshold.
 *   2. It returns to 0 the moment a stream opens, so a healthy session can
 *      never drift across the threshold no matter how long it runs.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import { SseConnectionManager } from "./sse-connection-manager.js";

/** An SSE server that holds the connection open with a keepalive comment. */
async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(": connected\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

/** A port nothing is listening on — every connect attempt is refused. */
async function deadPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  return port;
}

function makeManager(getUrl: () => string): {
  manager: SseConnectionManager;
  disconnects: number[];
} {
  const disconnects: number[] = [];
  const manager = new SseConnectionManager({
    logLabel: "test",
    getWorkerUrl: getUrl,
    workerReady: async () => undefined,
    onEvent: () => undefined,
    onDisconnect: (attempt) => { disconnects.push(attempt); return true; },
    isDisposed: () => false,
    resourcesStarted: () => true,
  });
  return { manager, disconnects };
}

/** Poll until `predicate` holds or the deadline passes. */
async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("SseConnectionManager.reconnectAttempts", () => {
  const managers: SseConnectionManager[] = [];
  afterEach(() => {
    for (const m of managers.splice(0)) m.disconnect();
    vi.restoreAllMocks();
  });

  it("starts at zero", () => {
    const { manager } = makeManager(() => "http://127.0.0.1:1");
    managers.push(manager);
    expect(manager.reconnectAttempts).toBe(0);
  });

  it("climbs while the worker refuses connections", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const port = await deadPort();
    const { manager, disconnects } = makeManager(() => `http://127.0.0.1:${port}`);
    managers.push(manager);

    void manager.connect();
    // The first two backoff steps are 1s and 2s, so three failures land well
    // inside the timeout without any fake-timer plumbing.
    await until(() => disconnects.length >= 3);

    expect(manager.reconnectAttempts).toBeGreaterThanOrEqual(3);
    // `onDisconnect` sees 1-based attempt numbers in order.
    expect(disconnects.slice(0, 3)).toEqual([1, 2, 3]);
  });

  it("resets to zero as soon as a stream opens", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const port = await deadPort();
    let url = `http://127.0.0.1:${port}`;
    const { manager, disconnects } = makeManager(() => url);
    managers.push(manager);

    void manager.connect();
    await until(() => disconnects.length >= 2);
    expect(manager.reconnectAttempts).toBeGreaterThan(0);

    // Point the manager at a live worker; the next scheduled attempt succeeds.
    const server = await startServer();
    url = server.url;
    await until(() => manager.isConnected);

    // This is what keeps a long-lived healthy session away from the
    // reconciler's threshold: a working stream zeroes the counter.
    expect(manager.reconnectAttempts).toBe(0);
    manager.disconnect();
    await server.close();
  });
});
