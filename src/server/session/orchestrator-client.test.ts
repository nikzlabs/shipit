import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import dns from "node:dns";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { setTimeout as realSleep } from "node:timers/promises";
import {
  OrchestratorClient,
  resolveOrchestratorBaseUrls,
} from "./orchestrator-client.js";
import { orchestratorFallbackHosts } from "../shared/orchestrator-hosts.js";

const OLD_ENV = { ...process.env };

const closers: (() => void)[] = [];

// The worker has no handler for these, so one ends the process; a vitest run does not report one by itself.
const uncaught: unknown[] = [];
const recordUncaught = (err: unknown): void => { uncaught.push(err); };

beforeEach(() => {
  process.on("uncaughtException", recordUncaught);
});

afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const close of closers.splice(0)) close();
  process.off("uncaughtException", recordUncaught);
  expect(uncaught.splice(0)).toEqual([]);
});

// Linux answers on every 127.x.x.x address, so two hosts can share one port as SHIPIT_HOST and its fallback do.
const FIRST_HOST = "127.0.0.2";
const SECOND_HOST = "127.0.0.1";

function listen(server: net.Server, host: string, port = 0): Promise<number> {
  const sockets = new Set<net.Socket>();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("error", () => undefined);
  });
  closers.push(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
  });
}

interface Counted {
  requests: number;
  connections: number;
}

function answeringServer(): { server: http.Server; seen: Counted } {
  const seen: Counted = { requests: 0, connections: 0 };
  const server = http.createServer((req, res) => {
    seen.requests += 1;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ from: "second" }));
    });
  });
  server.on("connection", () => { seen.connections += 1; });
  return { server, seen };
}

// A host that takes the connection and the whole request, then does `then` in place of an answer.
function failingServer(then: (socket: net.Socket) => void): { server: net.Server; seen: Counted } {
  const seen: Counted = { requests: 0, connections: 0 };
  const server = net.createServer((socket) => {
    seen.connections += 1;
    let received = Buffer.alloc(0);
    let done = false;
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const headEnd = received.indexOf("\r\n\r\n");
      if (done || headEnd < 0) return;
      const length = Number(/content-length: (\d+)/i.exec(received.subarray(0, headEnd).toString())?.[1] ?? 0);
      if (received.length < headEnd + 4 + length) return;
      done = true;
      seen.requests += 1;
      then(socket);
    });
  });
  return { server, seen };
}

// SHIPIT_HOST behaves as `first` does; the fallback host answers.
async function twoHosts(first: net.Server): Promise<{ client: OrchestratorClient; second: Counted }> {
  const { server, seen } = answeringServer();
  const port = await listen(server, SECOND_HOST);
  await listen(first, FIRST_HOST, port);
  process.env.SHIPIT_HOST = FIRST_HOST;
  process.env.SHIPIT_ORCHESTRATOR_FALLBACK_HOSTS = SECOND_HOST;
  process.env.SHIPIT_PORT = String(port);
  process.env.SESSION_ID = "sess-1";
  return { client: new OrchestratorClient(), second: seen };
}

// A stale name that the resolver never answers for; every other name resolves as usual.
async function hungFirstName(): Promise<{ client: OrchestratorClient; second: Counted }> {
  const { server, seen } = answeringServer();
  const port = await listen(server, SECOND_HOST);
  const realLookup = dns.lookup.bind(dns) as (...args: unknown[]) => void;
  vi.spyOn(dns, "lookup").mockImplementation(((...args: unknown[]) => {
    if (args[0] !== "stale-host.test") realLookup(...args);
  }) as never);
  process.env.SHIPIT_HOST = "stale-host.test";
  process.env.SHIPIT_ORCHESTRATOR_FALLBACK_HOSTS = SECOND_HOST;
  process.env.SHIPIT_PORT = String(port);
  process.env.SESSION_ID = "sess-1";
  return { client: new OrchestratorClient(), second: seen };
}

async function requestArrived(sockets: net.Socket[]): Promise<void> {
  while (sockets.length === 0) await realSleep(5);
}

function errorOf(res: { body: unknown }): string {
  return (res.body as { error: string }).error;
}

describe("resolveOrchestratorBaseUrls", () => {
  it("returns the configured host followed by stable fallback hosts", () => {
    process.env.SHIPIT_HOST = "old-container-id";
    process.env.SHIPIT_PORT = "4123";
    process.env.SHIPIT_ORCHESTRATOR_FALLBACK_HOSTS = "shipit,shipit";

    expect(resolveOrchestratorBaseUrls()).toEqual([
      "http://old-container-id:4123",
      "http://shipit:4123",
    ]);
  });

  it("falls back to the shared list's default, which the contained resolver forwards (planning#626)", () => {
    process.env.SHIPIT_HOST = "old-container-id";
    process.env.SHIPIT_PORT = "4123";
    delete process.env.SHIPIT_ORCHESTRATOR_FALLBACK_HOSTS;

    expect(resolveOrchestratorBaseUrls()).toEqual(
      ["old-container-id", ...orchestratorFallbackHosts()].map((h) => `http://${h}:4123`),
    );
    expect(orchestratorFallbackHosts()).toEqual(["shipit"]);
  });

  it("returns no URLs when the orchestrator env is missing", () => {
    delete process.env.SHIPIT_HOST;
    delete process.env.SHIPIT_PORT;

    expect(resolveOrchestratorBaseUrls()).toEqual([]);
  });
});

describe("OrchestratorClient", () => {
  describe("a host that the request cannot have reached", () => {
    it("goes to the next host when the first one refuses the connection", async () => {
      const { server, seen } = answeringServer();
      const port = await listen(server, SECOND_HOST);
      process.env.SHIPIT_HOST = FIRST_HOST;
      process.env.SHIPIT_ORCHESTRATOR_FALLBACK_HOSTS = SECOND_HOST;
      process.env.SHIPIT_PORT = String(port);
      process.env.SESSION_ID = "sess-1";

      const res = await new OrchestratorClient().request("POST", "/voice-note", { headline: "done" });

      expect(res).toEqual({ ok: true, status: 200, body: { from: "second" } });
      expect(seen.requests).toBe(1);
    });

    it("goes to the next host when the time limit ends before the connection is made", async () => {
      const { client, second } = await hungFirstName();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      // Shorter than the 10 s that a host gets to take the connection.
      const pending = client.request("POST", "/agent/own-turn", {}, { timeoutMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(await pending).toEqual({ ok: true, status: 200, body: { from: "second" } });
      expect(second.requests).toBe(1);
    });

    it("gives a host 10 s to take the connection, also for a call with no time limit", async () => {
      const { client, second } = await hungFirstName();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      const pending = client.request("POST", "/plugin/exec", {}, { timeoutMs: 0 });
      await vi.advanceTimersByTimeAsync(9_999);
      // Real time, in which a request that went to the next host too early would arrive.
      await realSleep(100);
      expect(second.requests).toBe(0);
      await vi.advanceTimersByTimeAsync(1);

      expect(await pending).toEqual({ ok: true, status: 200, body: { from: "second" } });
    });

    it("returns status 0 with every failure when no host takes the connection", async () => {
      process.env.SHIPIT_HOST = FIRST_HOST;
      process.env.SHIPIT_ORCHESTRATOR_FALLBACK_HOSTS = SECOND_HOST;
      process.env.SHIPIT_PORT = "1";
      process.env.SESSION_ID = "sess-1";

      const res = await new OrchestratorClient().request("POST", "/agent/spawn", { prompt: "x" }, { timeoutMs: 0 });

      expect(res).toEqual({
        ok: false,
        status: 0,
        body: {
          error: "Could not reach orchestrator (http://127.0.0.2:1: connect ECONNREFUSED 127.0.0.2:1; "
            + "http://127.0.0.1:1: connect ECONNREFUSED 127.0.0.1:1)",
        },
      });
    });
  });

  describe("a failure after the connection was made (docs/306-spawn-retry-safety req 6)", () => {
    it("does not send a POST again when the host closes the connection after it read the request", async () => {
      const first = failingServer((socket) => socket.destroy());
      const { client, second } = await twoHosts(first.server);

      const res = await client.request("POST", "/plugin/exec", { command: "deploy" }, { timeoutMs: 0 });

      expect(first.seen.requests).toBe(1);
      expect(second.requests).toBe(0);
      expect(res.ok).toBe(false);
      expect(res.status).toBe(0);
      expect(errorOf(res)).toContain("failed after the request was sent");
      expect(errorOf(res)).toContain("not sent again");
    });

    it("does not send a POST again when the answer is cut off, and does not read it as an empty success", async () => {
      const first = failingServer((socket) => {
        socket.write("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{\"sessionId\":");
        setTimeout(() => socket.destroy(), 20);
      });
      const { client, second } = await twoHosts(first.server);

      const res = await client.request("POST", "/spawn", { prompt: "x" });

      expect(second.requests).toBe(0);
      expect(res.ok).toBe(false);
      expect(res.status).toBe(0);
      expect(errorOf(res)).toContain("not sent again");
    });

    it("does not send a POST again when the time limit ends while the host has the request", async () => {
      const held: net.Socket[] = [];
      const first = failingServer((socket) => { held.push(socket); });
      const { client, second } = await twoHosts(first.server);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      const pending = client.request("POST", "/agent/own-turn", {}, { timeoutMs: 10_000 });
      await requestArrived(held);
      await vi.advanceTimersByTimeAsync(10_000);
      const res = await pending;

      expect(second.requests).toBe(0);
      expect(res.status).toBe(0);
      expect(errorOf(res)).toContain("no answer after 10000 ms");
      expect(errorOf(res)).toContain("not sent again");
      // The worker lets the connection go, so nothing stays open for an answer that nobody reads.
      while (!held[0].destroyed) await realSleep(5);
    });

    it("sends a GET to the next host, because a read does no harm twice", async () => {
      const first = failingServer((socket) => socket.destroy());
      const { client, second } = await twoHosts(first.server);

      const res = await client.request("GET", "/session-status");

      expect(first.seen.requests).toBe(1);
      expect(res).toEqual({ ok: true, status: 200, body: { from: "second" } });
      expect(second.requests).toBe(1);
    });
  });

  describe("the time limit after the connection was made", () => {
    const ANSWER = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 11\r\n\r\n{\"ok\":true}";

    async function silentHost(): Promise<{ client: OrchestratorClient; sockets: net.Socket[] }> {
      const sockets: net.Socket[] = [];
      const host = failingServer((socket) => { sockets.push(socket); });
      const port = await listen(host.server, SECOND_HOST);
      const client = new OrchestratorClient({ baseUrl: `http://127.0.0.1:${port}`, sessionId: "sess-1" });
      return { client, sockets };
    }

    it("is 300 s for a call that names none", async () => {
      const { client, sockets } = await silentHost();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      const pending = client.request("POST", "/voice-note", {});
      await requestArrived(sockets);
      await vi.advanceTimersByTimeAsync(299_999);
      expect(await Promise.race([pending, realSleep(50, "no result yet")])).toBe("no result yet");
      await vi.advanceTimersByTimeAsync(1);

      const res = await pending;
      expect(res.status).toBe(0);
      expect(errorOf(res)).toContain("no answer after 300000 ms");
    });

    it("does not exist for timeoutMs 0", async () => {
      const { client, sockets } = await silentHost();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      const pending = client.request("POST", "/plugin/exec", {}, { timeoutMs: 0 });
      await requestArrived(sockets);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(await Promise.race([pending, realSleep(50, "no result yet")])).toBe("no result yet");
      sockets[0].end(ANSWER);

      expect(await pending).toEqual({ ok: true, status: 200, body: { ok: true } });
    });
  });

  describe("a caller that goes away (docs/262-plugins req 32)", () => {
    const GONE = { ok: false, status: 0, body: { error: "The request was ended, because its caller went away." } };

    it("closes the connection, which is how the host learns it", async () => {
      const held: net.Socket[] = [];
      const first = failingServer((socket) => { held.push(socket); });
      const { client, second } = await twoHosts(first.server);
      const caller = new AbortController();

      const pending = client.request("POST", "/plugin/exec", {}, { timeoutMs: 0, signal: caller.signal });
      await requestArrived(held);
      caller.abort();

      expect(await pending).toEqual(GONE);
      while (!held[0].destroyed) await realSleep(5);
      expect(second.requests).toBe(0);
    });

    it.each(["POST", "GET"] as const)(
      "does not send a %s to the next host when the caller goes away before the connection is made",
      async (method) => {
        const { client, second } = await hungFirstName();
        const caller = new AbortController();

        const pending = client.request(method, "/plugin/exec", undefined, { timeoutMs: 0, signal: caller.signal });
        await realSleep(20);
        caller.abort();

        expect(await pending).toEqual(GONE);
        // Real time, in which a request that went to the next host would arrive.
        await realSleep(100);
        expect(second.requests).toBe(0);
      },
    );
  });

  it("opens a connection for each call, so that a failure cannot come from a connection used before", async () => {
    const { server, seen } = answeringServer();
    const port = await listen(server, SECOND_HOST);
    const client = new OrchestratorClient({ baseUrl: `http://127.0.0.1:${port}`, sessionId: "sess-1" });

    await client.request("POST", "/voice-note", {});
    await client.request("POST", "/voice-note", {});

    expect(seen).toEqual({ requests: 2, connections: 2 });
  });

  it("round-trips a JSON body", async () => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString(); });
      req.on("end", () => {
        const prompt = (JSON.parse(body || "{}") as { prompt?: string }).prompt;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ echoedPrompt: prompt, url: req.url, status: "success" }));
      });
    });
    const port = await listen(server, SECOND_HOST);
    const client = new OrchestratorClient({ baseUrl: `http://127.0.0.1:${port}`, sessionId: "sess-1" });

    const res = await client.request("POST", "/agent/spawn", { prompt: "review this" }, { timeoutMs: 0 });

    expect(res).toEqual({
      ok: true,
      status: 200,
      body: { echoedPrompt: "review this", url: "/api/sessions/sess-1/agent/spawn", status: "success" },
    });
  });

  it("returns a refusal as it is, and does not ask the next host", async () => {
    const first = http.createServer((_req, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Sub-agents are disabled." }));
    });
    const { client, second } = await twoHosts(first);

    const res = await client.request("POST", "/agent/spawn", { prompt: "x" }, { timeoutMs: 0 });

    expect(res).toEqual({ ok: false, status: 403, body: { error: "Sub-agents are disabled." } });
    expect(second.requests).toBe(0);
  });

  it("connects to an IPv6 address in the URL and does not look it up as a name", async () => {
    const client = new OrchestratorClient({ baseUrl: "http://[::1]:1", sessionId: "sess-1" });

    const res = await client.request("POST", "/voice-note", {});

    // Refused where IPv6 loopback exists, unreachable where it does not; never a lookup of "[::1]".
    expect(errorOf(res)).toMatch(/^Could not reach orchestrator \(http:\/\/\[::1\]:1: connect E/);
  });

  it("leaves no timer behind after an answer", async () => {
    const { server } = answeringServer();
    const port = await listen(server, SECOND_HOST);
    const client = new OrchestratorClient({ baseUrl: `http://127.0.0.1:${port}`, sessionId: "sess-1" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    await client.request("POST", "/voice-note", {});

    expect(vi.getTimerCount()).toBe(0);
  });
});
