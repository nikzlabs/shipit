import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { compactOpencode2Session, readTurnSteps, waitForMcpServers, waitForServerUrl, type Opencode2Server } from "./server.js";

const SERVER: Opencode2Server = { url: "http://127.0.0.1:5555", authorization: "Basic x" };

function fakeProc(): ChildProcess & { stdout: EventEmitter; stderr: EventEmitter } {
  const proc = new EventEmitter() as ChildProcess & { stdout: EventEmitter; stderr: EventEmitter };
  Object.assign(proc, { stdout: new EventEmitter(), stderr: new EventEmitter() });
  return proc;
}

function fetchSequence(bodies: unknown[]): typeof fetch {
  let i = 0;
  return vi.fn(async () => {
    const body = bodies[Math.min(i++, bodies.length - 1)];
    return new Response(body === undefined ? "" : JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("waitForServerUrl", () => {
  it("resolves with the URL 2.1.1 announces for --port 0", async () => {
    const proc = fakeProc();
    const url = waitForServerUrl(proc, 1_000);
    proc.stdout.emit("data", "server listening on http://127.0.0.1:36855\n");
    await expect(url).resolves.toBe("http://127.0.0.1:36855");
  });

  it("rejects with the server's own output when it exits first", async () => {
    const proc = fakeProc();
    const url = waitForServerUrl(proc, 1_000);
    proc.stderr.emit("data", "EADDRINUSE\n");
    proc.emit("exit", 1, null);
    await expect(url).rejects.toThrow("exited (code 1) before it was ready: EADDRINUSE");
  });
});

describe("waitForMcpServers", () => {
  const connected = (name: string) => ({ name, status: { status: "connected" } });

  it("does not take a Location that has loaded no config yet as settled", async () => {
    const fetchFn = fetchSequence([{ data: [] }, { data: [{ name: "a", status: { status: "pending" } }] }, { data: [connected("a")] }]);
    const result = await waitForMcpServers(SERVER, "/w", ["a"], fetchFn, { pollMs: 1, graceMs: 0 });
    expect(result).toEqual({ settled: true, statuses: [{ name: "a", state: "loaded" }] });
    expect(vi.mocked(fetchFn)).toHaveBeenCalledTimes(3);
  });

  it("counts a failed or auth-gated server as settled and reports why", async () => {
    const fetchFn = fetchSequence([{ data: [connected("a"), { name: "b", status: { status: "failed", error: "ENOENT" } }, { name: "c", status: { status: "needs_auth" } }] }]);
    const result = await waitForMcpServers(SERVER, "/w", ["a", "b", "c"], fetchFn, { pollMs: 1, graceMs: 0 });
    expect(result.settled).toBe(true);
    expect(result.statuses).toEqual([
      { name: "a", state: "loaded" },
      { name: "b", state: "failed", reason: "ENOENT" },
      { name: "c", state: "failed", reason: "status: needs_auth" },
    ]);
  });

  it("gives up at its deadline instead of holding the turn", async () => {
    const fetchFn = fetchSequence([{ data: [{ name: "a", status: { status: "pending" } }] }]);
    const result = await waitForMcpServers(SERVER, "/w", ["a"], fetchFn, { timeoutMs: 20, pollMs: 1, graceMs: 0 });
    expect(result.settled).toBe(false);
  });
});

describe("readTurnSteps", () => {
  it("returns the newest turn's model calls oldest first, across pages", async () => {
    const fetchFn = fetchSequence([
      { data: [{ type: "idle" }, { type: "assistant", tokens: { input: 3 }, cost: 0.3 }], cursor: { next: "c1" } },
      { data: [{ type: "assistant", tokens: { input: 2 } }, { type: "user" }, { type: "assistant", tokens: { input: 1 } }], cursor: {} },
    ]);
    const steps = await readTurnSteps(SERVER, "ses_1", fetchFn);
    expect(steps).toEqual([{ tokens: { input: 2 } }, { tokens: { input: 3 }, cost: 0.3 }]);
    expect(vi.mocked(fetchFn).mock.calls[1][0]).toBe("http://127.0.0.1:5555/api/session/ses_1/message?limit=100&cursor=c1");
  });
});

describe("compactOpencode2Session", () => {
  it("switches the session to the selected model, then waits for the compaction to finish", async () => {
    const fetchFn = fetchSequence([undefined, { data: { id: "m1" } }, { data: { status: "running" } }, { data: { status: "completed" } }]);
    await compactOpencode2Session(SERVER, "ses_1", { providerID: "shipit", id: "m" }, fetchFn, { pollMs: 1 });
    expect(vi.mocked(fetchFn).mock.calls.map((c) => c[0] as string)).toEqual([
      "http://127.0.0.1:5555/api/session/ses_1/model",
      "http://127.0.0.1:5555/api/session/ses_1/compact",
      "http://127.0.0.1:5555/api/session/ses_1/message/m1",
      "http://127.0.0.1:5555/api/session/ses_1/message/m1",
    ]);
  });

  it("rejects with the server's reason when compaction fails", async () => {
    const fetchFn = fetchSequence([undefined, { data: { id: "m1" } }, { data: { status: "failed", error: { message: "no template" } } }]);
    await expect(compactOpencode2Session(SERVER, "ses_1", { providerID: "shipit", id: "m" }, fetchFn, { pollMs: 1 }))
      .rejects.toThrow("no template");
  });
});
