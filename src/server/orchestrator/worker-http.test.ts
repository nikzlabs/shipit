import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import {
  workerGet,
  workerPost,
  workerPut,
  PLACEHOLDER_WORKER_URL,
  WorkerUnavailableError,
} from "./worker-http.js";

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
 * A runner holds `http://0.0.0.0:0` between construction and `setWorkerUrl()`.
 * `dispose()` resolves its worker-ready gate so pending awaiters don't leak,
 * which means a turn parked on that gate can reach the transport with the
 * placeholder still set. Dialing it produced `connect ECONNREFUSED 0.0.0.0`
 * (Node omits the `:0`) — a chat error that named neither the session
 * container nor the real failure. The guard lives at the transport so no call
 * site can forget it.
 */
describe("placeholder worker URL is never dialed", () => {
  const verbs: [string, () => Promise<unknown>][] = [
    ["workerGet", () => workerGet(PLACEHOLDER_WORKER_URL, "/agent/status")],
    ["workerPost", () => workerPost(PLACEHOLDER_WORKER_URL, "/agent/start", { a: 1 })],
    ["workerPut", () => workerPut(PLACEHOLDER_WORKER_URL, "/secrets", { a: 1 })],
  ];

  for (const [name, call] of verbs) {
    it(`${name} rejects with WorkerUnavailableError instead of ECONNREFUSED`, async () => {
      await expect(call()).rejects.toBeInstanceOf(WorkerUnavailableError);
      // The exact string users used to see. It must not survive anywhere in
      // the message — that regression is the whole point of this guard.
      await expect(call()).rejects.not.toThrow(/ECONNREFUSED|0\.0\.0\.0/);
    });
  }

  it("names the container so the message is actionable", async () => {
    await expect(workerPost(PLACEHOLDER_WORKER_URL, "/agent/start")).rejects.toThrow(
      /session container isn't running/i,
    );
  });

  it("rejects (not throws synchronously) so fire-and-forget call sites still swallow it", async () => {
    // Dozens of call sites are `workerPost(url, path).catch(() => {})`. A
    // synchronous throw would escape those handlers and take down `dispose()`.
    let threwSynchronously = false;
    try {
      void workerPost(PLACEHOLDER_WORKER_URL, "/agent/kill").catch(() => undefined);
    } catch {
      threwSynchronously = true;
    }
    expect(threwSynchronously).toBe(false);
  });

  it("carries the recorded cause when one is supplied", () => {
    const err = new WorkerUnavailableError("/agent/start", "no space left on device");
    expect(err.message).toContain("no space left on device");
  });
});
