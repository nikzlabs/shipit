import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import { SseConnectionManager } from "./sse-connection-manager.js";

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

    await until(() => disconnects.length >= 3);
    expect(manager.streamDownSince).toBe(latched);
  });

  it("latches even when onDisconnect aborts the reconnect schedule", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const port = await deadPort();
    const { manager, disconnects } = makeManager(() => `http://127.0.0.1:${port}`, () => false);
    managers.push(manager);

    void manager.connect();
    await until(() => disconnects.length >= 1);

    expect(manager.streamDownSince).toBeGreaterThan(0);
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

    const server = await startServer();
    url = server.url;
    // isConnected reports the request handle before onOpen resets the timestamp.
    await until(() => opens() >= 1);

    expect(manager.streamDownSince).toBe(0);
    manager.disconnect();
    await server.close();
  });
});
