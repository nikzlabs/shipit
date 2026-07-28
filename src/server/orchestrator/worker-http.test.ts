import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type net from "node:net";
import { workerGet, workerPost, workerPut, WorkerAbortError } from "./worker-http.js";

/**
 * Spin up a throwaway HTTP server that responds to every request with the
 * given status + body, so we can exercise the shared response handler
 * (`attachWorkerResponseHandler`) through each verb without a real worker.
 */
async function startWorker(
  status: number,
  body: string,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no server address");
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("worker HTTP response handling", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  // The three verbs share `attachWorkerResponseHandler`, so run the same
  // matrix across all of them to guarantee byte-identical behavior.
  const verbs: [string, (baseUrl: string) => Promise<unknown>][] = [
    ["workerGet", (baseUrl) => workerGet(baseUrl, "/x")],
    ["workerPost", (baseUrl) => workerPost(baseUrl, "/x", { a: 1 })],
    ["workerPut", (baseUrl) => workerPut(baseUrl, "/x", { a: 1 })],
  ];

  for (const [name, call] of verbs) {
    describe(name, () => {
      it("resolves with the parsed JSON body on success", async () => {
        const worker = await startWorker(200, JSON.stringify({ ok: true, value: 42 }));
        close = worker.close;
        await expect(call(worker.baseUrl)).resolves.toEqual({ ok: true, value: 42 });
      });

      it("rejects with the worker's .error field on HTTP >= 400", async () => {
        const worker = await startWorker(500, JSON.stringify({ error: "boom" }));
        close = worker.close;
        await expect(call(worker.baseUrl)).rejects.toThrow("boom");
      });

      it("rejects with HTTP <status> when a >= 400 body has no .error", async () => {
        const worker = await startWorker(404, JSON.stringify({ nope: true }));
        close = worker.close;
        await expect(call(worker.baseUrl)).rejects.toThrow("HTTP 404");
      });

      it("rejects with the invalid-response message on non-JSON body", async () => {
        const worker = await startWorker(200, "<html>not json</html>");
        close = worker.close;
        await expect(call(worker.baseUrl)).rejects.toThrow(
          "Invalid response from worker: <html>not json</html>",
        );
      });
    });
  }
});

/**
 * docs/144 — the unbounded sub-agent spawn leg is bounded by nothing but the
 * sub-agent's own 30-minute cap, so the caller-went-away case has to travel as
 * an abort. These cover the transport half: a fired signal tears the socket
 * down with a distinguishable error, and an already-aborted signal never opens
 * one (which would spawn a sub-agent nobody is waiting for).
 */
describe("workerPost abort signal", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  /** A worker that accepts the request and then never answers. */
  async function startHangingWorker(): Promise<{
    baseUrl: string;
    received: Promise<void>;
    close: () => Promise<void>;
  }> {
    let onReceived: () => void = () => {};
    const received = new Promise<void>((resolve) => { onReceived = resolve; });
    const sockets: net.Socket[] = [];
    const server = http.createServer((req) => {
      req.resume();
      onReceived();
      // Deliberately no response — the caller must abort to get out.
    });
    server.on("connection", (socket) => { sockets.push(socket); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (typeof addr === "string" || !addr) throw new Error("no server address");
    return {
      baseUrl: `http://127.0.0.1:${addr.port}`,
      received,
      close: () => new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
    };
  }

  it("rejects with WorkerAbortError when the signal fires mid-request", async () => {
    const worker = await startHangingWorker();
    close = worker.close;
    const controller = new AbortController();
    const pending = workerPost(worker.baseUrl, "/agent/spawn", { a: 1 }, {
      timeoutMs: 0,
      signal: controller.signal,
    });
    // Only abort once the worker has the request in hand — that's the real
    // scenario (a sub-agent already running), not a race before connect.
    await worker.received;
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(WorkerAbortError);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const worker = await startHangingWorker();
    close = worker.close;
    const controller = new AbortController();
    controller.abort();
    await expect(
      workerPost(worker.baseUrl, "/agent/spawn", { a: 1 }, { timeoutMs: 0, signal: controller.signal }),
    ).rejects.toBeInstanceOf(WorkerAbortError);
  });

  it("resolves normally when the signal never fires", async () => {
    const worker = await startWorker(200, JSON.stringify({ status: "success" }));
    close = worker.close;
    const controller = new AbortController();
    await expect(
      workerPost(worker.baseUrl, "/agent/spawn", { a: 1 }, { timeoutMs: 0, signal: controller.signal }),
    ).resolves.toEqual({ status: "success" });
  });
});
