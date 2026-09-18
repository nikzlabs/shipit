import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { Socket } from "node:net";
import {
  workerGet,
  workerPost,
  workerPut,
  PLACEHOLDER_WORKER_URL,
  WorkerUnavailableError,
  WorkerAbortedError,
} from "./worker-http.js";

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

describe("placeholder worker URL is never dialed", () => {
  const verbs: [string, () => Promise<unknown>][] = [
    ["workerGet", () => workerGet(PLACEHOLDER_WORKER_URL, "/agent/status")],
    ["workerPost", () => workerPost(PLACEHOLDER_WORKER_URL, "/agent/start", { a: 1 })],
    ["workerPut", () => workerPut(PLACEHOLDER_WORKER_URL, "/secrets", { a: 1 })],
  ];

  for (const [name, call] of verbs) {
    it(`${name} rejects with WorkerUnavailableError instead of ECONNREFUSED`, async () => {
      await expect(call()).rejects.toBeInstanceOf(WorkerUnavailableError);
      await expect(call()).rejects.not.toThrow(/ECONNREFUSED|0\.0\.0\.0/);
    });
  }

  it("names the container so the message is actionable", async () => {
    await expect(workerPost(PLACEHOLDER_WORKER_URL, "/agent/start")).rejects.toThrow(
      /session container isn't running/i,
    );
  });

  it("rejects (not throws synchronously) so fire-and-forget call sites still swallow it", async () => {
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

describe("workerPost — abort signal", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  async function startSilentWorker(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
    const sockets: Socket[] = [];
    const server = http.createServer(() => { /* never respond */ });
    server.on("connection", (s) => sockets.push(s));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (typeof addr === "string" || !addr) throw new Error("no server address");
    return {
      baseUrl: `http://127.0.0.1:${addr.port}`,
      close: () => new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
    };
  }

  it("rejects with WorkerAbortedError when the signal fires mid-request", async () => {
    const worker = await startSilentWorker();
    close = worker.close;
    const controller = new AbortController();
    const p = workerPost(worker.baseUrl, "/agent/spawn", { a: 1 }, {
      timeoutMs: 0,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort("runner disposed"), 20);
    await expect(p).rejects.toBeInstanceOf(WorkerAbortedError);
    await expect(p).rejects.toThrow(/runner disposed/);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const worker = await startSilentWorker();
    close = worker.close;
    await expect(
      workerPost(worker.baseUrl, "/agent/spawn", { a: 1 }, {
        timeoutMs: 0,
        signal: AbortSignal.abort("already gone"),
      }),
    ).rejects.toBeInstanceOf(WorkerAbortedError);
  });

  it("leaves an un-aborted request alone", async () => {
    const worker = await startWorker(200, JSON.stringify({ ok: true }));
    close = worker.close;
    const controller = new AbortController();
    await expect(
      workerPost(worker.baseUrl, "/x", { a: 1 }, { signal: controller.signal }),
    ).resolves.toEqual({ ok: true });
  });
});
