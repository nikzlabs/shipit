import { describe, it, expect, afterEach, beforeEach } from "vitest";
import http from "node:http";
import { once } from "node:events";
import Fastify, { type FastifyInstance } from "fastify";
import { registerPreviewProxy, stripPreviewPrefix } from "./preview-proxy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a simple upstream HTTP server that echoes request info. */
function createUpstreamServer(): http.Server {
  return http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, method: req.method, host: req.headers.host }));
  });
}

/** Start a server on an ephemeral port and return the port. */
async function listenOnEphemeral(server: http.Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  return typeof addr === "object" && addr ? addr.port : 0;
}

/** Simple HTTP GET via Node's http module. Returns status + body + headers. */
function httpGet(url: string): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({
        statusCode: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString(),
        headers: res.headers,
      }));
    }).on("error", reject);
  });
}

/** Simple HTTP request via Node's http module. */
function httpRequest(
  method: string,
  url: string,
): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, method },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({
          statusCode: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString(),
          headers: res.headers,
        }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("stripPreviewPrefix", () => {
  it("strips prefix and returns path", () => {
    expect(stripPreviewPrefix("/preview/8080/api/users", 8080)).toBe("/api/users");
  });

  it("returns / for root path", () => {
    expect(stripPreviewPrefix("/preview/8080/", 8080)).toBe("/");
  });

  it("preserves query strings", () => {
    expect(stripPreviewPrefix("/preview/5173/search?q=test", 5173)).toBe("/search?q=test");
  });

  it("returns / when no trailing path", () => {
    expect(stripPreviewPrefix("/preview/8080", 8080)).toBe("/");
  });
});

describe("preview-proxy HTTP", () => {
  let app: FastifyInstance;
  let appPort: number;
  let upstream: http.Server;
  let upstreamPort: number;
  const allowedPorts = new Set<number>();

  beforeEach(async () => {
    upstream = createUpstreamServer();
    upstreamPort = await listenOnEphemeral(upstream);
    allowedPorts.clear();
    allowedPorts.add(upstreamPort);

    app = Fastify({ logger: false });
    registerPreviewProxy(app, { isPortAllowed: (p) => allowedPorts.has(p) });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = address.match(/:(\d+)$/);
    appPort = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    await app.close();
    upstream.close();
  });

  // ---- Port validation ----

  it("returns 403 for disallowed ports", async () => {
    const res = await httpGet(`http://127.0.0.1:${appPort}/preview/9999/`);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe("Port not allowed");
  });

  it("returns 403 for non-integer port", async () => {
    const res = await httpGet(`http://127.0.0.1:${appPort}/preview/abc/`);
    expect(res.statusCode).toBe(403);
  });

  it("returns 403 for port 0", async () => {
    const res = await httpGet(`http://127.0.0.1:${appPort}/preview/0/`);
    expect(res.statusCode).toBe(403);
  });

  it("returns 403 for port > 65535", async () => {
    const res = await httpGet(`http://127.0.0.1:${appPort}/preview/70000/`);
    expect(res.statusCode).toBe(403);
  });

  // ---- Proxying ----

  it("proxies GET / to upstream root", async () => {
    const res = await httpGet(`http://127.0.0.1:${appPort}/preview/${upstreamPort}/`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.path).toBe("/");
    expect(body.method).toBe("GET");
  });

  it("strips prefix and forwards path", async () => {
    const res = await httpGet(`http://127.0.0.1:${appPort}/preview/${upstreamPort}/api/users`);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).path).toBe("/api/users");
  });

  it("preserves query strings", async () => {
    const res = await httpGet(`http://127.0.0.1:${appPort}/preview/${upstreamPort}/search?q=test&page=2`);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).path).toBe("/search?q=test&page=2");
  });

  it("sets host header to localhost:{port}", async () => {
    const res = await httpGet(`http://127.0.0.1:${appPort}/preview/${upstreamPort}/`);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).host).toBe(`localhost:${upstreamPort}`);
  });

  it("forwards POST requests", async () => {
    const res = await httpRequest("POST", `http://127.0.0.1:${appPort}/preview/${upstreamPort}/api/data`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.method).toBe("POST");
    expect(body.path).toBe("/api/data");
  });

  // ---- Bare path redirect ----

  it("redirects /preview/:port to /preview/:port/", async () => {
    const res = await httpGet(`http://127.0.0.1:${appPort}/preview/${upstreamPort}`);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/preview/${upstreamPort}/`);
  });

  // ---- 502 for unreachable upstream ----

  it("returns 502 when upstream is not listening", async () => {
    allowedPorts.add(19999);
    const res = await httpGet(`http://127.0.0.1:${appPort}/preview/19999/`);
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).error).toBe("Upstream unreachable");
  });
});
