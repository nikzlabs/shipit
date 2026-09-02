/**
 * The preview proxy absorbs a dev server that is not listening yet (docs/286).
 *
 * These are the tests that used to be impossible to write on the client: the
 * wait now happens in one place, so "a preview opened too early still shows the
 * app" is a property of the proxy rather than of a poll loop plus an overlay.
 */

import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  registerPreviewProxy,
  buildConnectingPage,
  isRetryablePreviewRequest,
  wantsHtmlDocument,
} from "./preview-proxy.js";
import type { SessionContainerManager } from "./session-container.js";
import type { ServiceManager } from "./service-manager.js";

const SESSION = "98f05156-7e64-422d-81bc-ba677fda60e0";

const teardown: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (teardown.length) await teardown.pop()!();
});

/** Start the proxy in front of a container IP that may have nothing on it yet. */
async function startProxy(opts: { connectRetryMs?: number } = {}): Promise<string> {
  const app: FastifyInstance = Fastify();
  registerPreviewProxy(app, {
    containerManager: {
      get: () => ({ containerIp: "127.0.0.1" }),
    } as unknown as SessionContainerManager,
    serviceManagers: new Map<string, ServiceManager>(),
    ...(opts.connectRetryMs !== undefined ? { connectRetryMs: opts.connectRetryMs } : {}),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  teardown.push(async () => { await app.close(); });
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

/** An upstream "dev server" the test can start late, the way a real one boots. */
async function startUpstream(
  port: number,
  body: string,
  contentType = "text/html",
  extraHeaders: http.OutgoingHttpHeaders = {},
): Promise<void> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": contentType, ...extraHeaders });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  teardown.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));
}

/** A free port nothing is listening on yet. */
async function reservePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => { probe.close(() => resolve()); });
  return port;
}

interface PreviewResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * Issue a preview request. `node:http` rather than `fetch`, because routing is
 * decided by the `Host` header and undici refuses to let a caller set one.
 */
function previewRequest(
  base: string,
  port: number,
  opts: { method?: string; accept?: string; body?: string } = {},
): Promise<PreviewResponse> {
  const url = new URL(base);
  const headers: http.OutgoingHttpHeaders = {
    host: `${SESSION}--${port}.localhost`,
    accept: opts.accept ?? "text/html",
  };
  if (opts.body !== undefined) headers["content-length"] = Buffer.byteLength(opts.body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: "/", method: opts.method ?? "GET", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf-8"),
        }));
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

describe("preview proxy — connect retry", () => {
  it("serves the app when the dev server comes up after the request", async () => {
    // The case the client's health poll existed to cover: the iframe asks
    // before anything is listening. The request is held and retried, so the
    // one load an iframe gets lands on the real app (req 2).
    const port = await reservePort();
    const base = await startProxy();

    const pending = previewRequest(base, port);
    await new Promise((r) => setTimeout(r, 400));
    await startUpstream(port, "<html><head></head><body>up</body></html>");

    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body).toContain("<body>up</body>");
  });

  it("answers a navigation with the connecting page once the window is exhausted", async () => {
    const port = await reservePort();
    const base = await startProxy({ connectRetryMs: 0 });

    const res = await previewRequest(base, port);
    const body = res.body;

    expect(res.status).toBe(503);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(body).toContain(`Connecting to the dev server on port <code>${port}</code>`);
    // Served through the bootstrap, so it posts `loaded` like any other preview
    // document — otherwise PreviewFrame's auth detector would reload it twice
    // and then report "Preview authentication required" (req 6).
    expect(body).toContain('postMessage({source:"shipit-preview",type:"loaded"}');
  });

  it("gives an asset the JSON error, not an HTML page", async () => {
    // A stylesheet or an XHR handed HTML would be a parse error in the app
    // rather than an honest failure.
    const port = await reservePort();
    const base = await startProxy({ connectRetryMs: 0 });

    const res = await previewRequest(base, port, { accept: "text/css" });

    expect(res.status).toBe(502);
    expect(JSON.parse(res.body)).toEqual({ error: "Container preview unreachable" });
  });

  it("gives up inside the window when the target never answers the connect", async () => {
    // A container whose address is stale drops the SYN rather than refusing it,
    // so no error ever fires and the retry deadline — only consulted from an
    // error callback — is never reached. Without the connect-phase timeout the
    // request hangs forever and the connecting page never appears.
    // 203.0.113.0/24 is TEST-NET-3: reserved for documentation, routed nowhere.
    const app: FastifyInstance = Fastify();
    registerPreviewProxy(app, {
      containerManager: { get: () => ({ containerIp: "203.0.113.1" }) } as unknown as SessionContainerManager,
      serviceManagers: new Map<string, ServiceManager>(),
      connectRetryMs: 0,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    teardown.push(async () => { await app.close(); });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

    const res = await previewRequest(base, 3000);
    expect(res.status).toBe(503);
    expect(res.body).toContain("Connecting to the dev server");
  }, 15_000);

  it("does not retry a request whose body it cannot replay", async () => {
    // A POST body is consumed by the first attempt, so a retry would send an
    // empty one. It fails as it always did — and fast, which is what this
    // asserts: the whole call finishes well inside the retry window.
    const port = await reservePort();
    const base = await startProxy();

    const started = Date.now();
    const res = await previewRequest(base, port, { method: "POST", body: "x=1" });

    expect(res.status).toBe(502);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("preview proxy — renderer isolation", () => {
  // Every preview origin is a subdomain of the host ShipIt itself is served
  // from, so a browser's site-keyed process model puts them all in one
  // renderer — one main thread, and one 16-context WebGL budget shared by every
  // open session. `Origin-Agent-Cluster: ?1` is what splits them.

  it("marks a served page, so its origin gets its own renderer", async () => {
    const port = await reservePort();
    const base = await startProxy();
    await startUpstream(port, "<html><head></head><body>up</body></html>");

    const res = await previewRequest(base, port);

    expect(res.status).toBe(200);
    expect(res.headers["origin-agent-cluster"]).toBe("?1");
  });

  it("marks the connecting page, which is the origin's first document on a cold boot", async () => {
    // The load-bearing one. An origin's agent-cluster key is decided by the
    // first document it serves and then held for the whole browsing-context
    // group, so a preview opened before its dev server is listening would be
    // pinned site-keyed for the rest of the session if only the real page
    // carried the header.
    const port = await reservePort();
    const base = await startProxy({ connectRetryMs: 0 });

    const res = await previewRequest(base, port);

    expect(res.status).toBe(503);
    expect(res.headers["origin-agent-cluster"]).toBe("?1");
  });

  it("marks a non-HTML response, which a navigation can also land on", async () => {
    const port = await reservePort();
    const base = await startProxy();
    await startUpstream(port, "body{}", "text/css");

    const res = await previewRequest(base, port, { accept: "text/css" });

    expect(res.status).toBe(200);
    expect(res.headers["origin-agent-cluster"]).toBe("?1");
  });

  it("leaves an app that states its own agent-cluster keying alone", async () => {
    // Nothing an agent builds sets this by accident; one that does knows
    // something about its own frames that we don't.
    const port = await reservePort();
    const base = await startProxy();
    await startUpstream(port, "<html><head></head><body>up</body></html>", "text/html", {
      "Origin-Agent-Cluster": "?0",
    });

    const res = await previewRequest(base, port);

    expect(res.headers["origin-agent-cluster"]).toBe("?0");
  });
});

describe("isRetryablePreviewRequest", () => {
  it("accepts a bodyless GET and HEAD", () => {
    expect(isRetryablePreviewRequest("GET", {})).toBe(true);
    expect(isRetryablePreviewRequest("head", {})).toBe(true);
  });

  it("refuses anything carrying a body, however it is framed", () => {
    expect(isRetryablePreviewRequest("POST", {})).toBe(false);
    expect(isRetryablePreviewRequest("GET", { "content-length": "4" })).toBe(false);
    expect(isRetryablePreviewRequest("GET", { "transfer-encoding": "chunked" })).toBe(false);
  });
});

describe("wantsHtmlDocument", () => {
  it("is true for a navigation", () => {
    expect(wantsHtmlDocument("GET", { accept: "text/html,application/xhtml+xml" })).toBe(true);
  });

  it("is false for an asset, a HEAD, and a request with no Accept", () => {
    expect(wantsHtmlDocument("GET", { accept: "text/css,*/*;q=0.1" })).toBe(false);
    expect(wantsHtmlDocument("HEAD", { accept: "text/html" })).toBe(false);
    expect(wantsHtmlDocument("GET", {})).toBe(false);
  });
});

describe("buildConnectingPage", () => {
  it("cannot be broken out of by the error text it embeds", () => {
    // The message comes from a connect error. It is quoted into an inline
    // script, so a literal </script> in it must not end the element.
    const page = buildConnectingPage(3000, "</script><img src=x onerror=alert(1)>");
    expect(page).not.toContain("</script><img");
    expect(page).toContain("\\u003c/script>");
  });

  it("polls and only then reloads, so it does not flicker through a slow boot", () => {
    const page = buildConnectingPage(3000, "ECONNREFUSED");
    // A blind reload on a timer would flash the pane for the whole of a boot;
    // this page is what the user watches for that entire time.
    expect(page).toContain("fetch(location.href");
    expect(page).toContain("res.status !== 503");
    expect(page).toContain("location.reload()");
  });
});
