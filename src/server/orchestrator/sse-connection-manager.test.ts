/**
 * Tests for `SseConnectionManager.streamDownSince`.
 *
 * docs/121 gap E promotes "is this stream down?" from an internal backoff
 * detail to a decision input: the missing-container reconciler reads it as
 * "this worker has stopped answering" and, past a threshold, checks the
 * container against Docker. Three properties have to hold for that gate to
 * be safe, and the third is why this is a timestamp rather than the reconnect
 * counter:
 *
 *   1. It latches when the stream goes down, so a dead session eventually
 *      crosses the threshold.
 *   2. It returns to 0 the moment a stream opens, so a healthy session can
 *      never drift across the threshold no matter how long it runs.
 *   3. It latches even when `onDisconnect` ABORTS the reconnect schedule.
 *      The runner does exactly that once the terminal-only reconnect cap is
 *      exhausted (`ContainerSessionRunner.onSseDisconnect`), which freezes
 *      any attempt count at the cap forever — an attempt-count gate would
 *      never fire in precisely the sessions that are most thoroughly stuck.
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

function makeManager(
  getUrl: () => string,
  onDisconnect: (attempt: number) => boolean = () => true,
): { manager: SseConnectionManager; disconnects: number[]; opens: () => number } {
  const disconnects: number[] = [];
  let openCount = 0;
  const manager = new SseConnectionManager({
    logLabel: "test",
    getWorkerUrl: getUrl,
    workerReady: async () => undefined,
    onEvent: () => undefined,
    onOpen: () => { openCount++; },
    onDisconnect: (attempt) => { disconnects.push(attempt); return onDisconnect(attempt); },
    isDisposed: () => false,
    resourcesStarted: () => true,
  });
  return { manager, disconnects, opens: () => openCount };
}

/** Poll until `predicate` holds or the deadline passes. */
async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("SseConnectionManager.streamDownSince", () => {
  const managers: SseConnectionManager[] = [];
  afterEach(() => {
    for (const m of managers.splice(0)) m.disconnect();
    vi.restoreAllMocks();
  });

  it("is zero before the stream has ever gone down", () => {
    const { manager } = makeManager(() => "http://127.0.0.1:1");
    managers.push(manager);
    expect(manager.streamDownSince).toBe(0);
  });

  it("latches when the worker refuses connections and does not move on retries", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const port = await deadPort();
    const { manager, disconnects } = makeManager(() => `http://127.0.0.1:${port}`);
    managers.push(manager);

    void manager.connect();
    await until(() => disconnects.length >= 1);
    const latched = manager.streamDownSince;
    expect(latched).toBeGreaterThan(0);

    // It marks when the stream went down, not when it last retried — so the
    // elapsed time the reconciler measures keeps growing.
    await until(() => disconnects.length >= 3);
    expect(manager.streamDownSince).toBe(latched);
  });

  it("latches even when onDisconnect aborts the reconnect schedule", async () => {
    // This is the terminal-cap case. No further reconnects will ever be
    // attempted, so nothing else would ever advance a counter — but the
    // session is as dead as it gets and must still be detectable.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const port = await deadPort();
    const { manager, disconnects } = makeManager(() => `http://127.0.0.1:${port}`, () => false);
    managers.push(manager);

    void manager.connect();
    await until(() => disconnects.length >= 1);

    expect(manager.streamDownSince).toBeGreaterThan(0);
    // Aborted: exactly one disconnect, no retry schedule behind it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(disconnects).toEqual([1]);
    expect(manager.streamDownSince).toBeGreaterThan(0);
  });

  it("resets to zero as soon as a stream opens", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const port = await deadPort();
    let url = `http://127.0.0.1:${port}`;
    const { manager, disconnects, opens } = makeManager(() => url);
    managers.push(manager);

    void manager.connect();
    await until(() => disconnects.length >= 2);
    expect(manager.streamDownSince).toBeGreaterThan(0);

    // Point the manager at a live worker; the next scheduled attempt succeeds.
    const server = await startServer();
    url = server.url;
    // Wait on `onOpen`, NOT on `isConnected`: the handle is assigned when the
    // request is issued, so `isConnected` flips one tick before the response
    // opens and the reset runs.
    await until(() => opens() >= 1);

    // This is what keeps a long-lived healthy session away from the
    // reconciler's threshold.
    expect(manager.streamDownSince).toBe(0);
    manager.disconnect();
    await server.close();
  });
});
