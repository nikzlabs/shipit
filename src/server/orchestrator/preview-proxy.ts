/**
 * Preview Proxy — session-ID-based reverse proxy for preview traffic.
 *
 * Subdomain routing — {sessionId}--{port}.localhost routes ALL requests to
 * the container's bridge IP. Absolute paths (/src/main.tsx, /@vite/client)
 * resolve naturally against the subdomain origin without any HTML rewriting —
 * works with any dev server, not just Vite. This is the ONLY container-preview
 * routing mode: a path-based (/preview/:sessionId/:port/*) variant existed but
 * was removed (docs/175) — it couldn't render real apps because absolute asset
 * paths 404 without the prefix, and no HTML rewriting was done. Container
 * reachability is probed separately via /api/preview-health/:sessionId/:port.
 *
 * Supports WebSocket upgrades for HMR.
 *
 * Registered when a SessionContainerManager is available (production mode).
 */

import http from "node:http";
import type { Duplex } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { SessionContainerManager } from "./session-container.js";
import type { ServiceManager } from "./service-manager.js";
import type { SessionRunnerRegistry } from "./session-runner.js";

// ---------------------------------------------------------------------------
// Subdomain parsing
// ---------------------------------------------------------------------------

/**
 * Parse a preview subdomain from the Host header.
 * Pattern: {uuid}--{port}.anything[:serverPort]
 * Example: 98f05156-7e64-422d-81bc-ba677fda60e0--5173.localhost:3001
 */
function parsePreviewSubdomain(
  host: string | undefined,
): { sessionId: string; port: number } | null {
  if (!host) return null;
  const hostname = host.split(":")[0]; // Strip server port
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})--(\d+)\./i.exec(hostname);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { sessionId: match[1], port };
}

// ---------------------------------------------------------------------------
// HMR WebSocket patch
// ---------------------------------------------------------------------------

/**
 * Tiny script injected into HTML responses from the container's dev server.
 * Dev servers (Vite, Webpack, etc.) open HMR WebSocket connections to their own
 * listening address (e.g. localhost:5173). From the browser, that address doesn't
 * reach the container — it needs to go through our subdomain proxy instead.
 *
 * This script wraps the WebSocket constructor to rewrite localhost connections
 * to use the page's origin, which our proxy then forwards to the container.
 */
const HMR_WS_PATCH = `<script>(function(){` +
  `var O=WebSocket;` +
  `window.WebSocket=function(u,p){` +
    `try{var a=new URL(u);` +
    `if((a.hostname==="localhost"||a.hostname==="127.0.0.1")&&a.port!==location.port){` +
      `a.hostname=location.hostname;a.port=location.port;u=a.toString()` +
    `}}catch(e){}` +
    `return new O(u,p)};` +
  `window.WebSocket.prototype=O.prototype;` +
  `window.WebSocket.CONNECTING=0;window.WebSocket.OPEN=1;` +
  `window.WebSocket.CLOSING=2;window.WebSocket.CLOSED=3;` +
  // Notify parent that the preview loaded successfully (used to detect
  // auth-blocked iframes when behind a reverse proxy like Cloudflare Zero Trust)
  `if(window.parent!==window){` +
    `window.parent.postMessage({source:"shipit-preview",type:"loaded"},"*")` +
  `}` +
  `})()</script>`;

// ---------------------------------------------------------------------------
// Forwarded headers
// ---------------------------------------------------------------------------

/**
 * Build the request headers for an upstream proxy hop.
 *
 * Two things happen here, and they pull in opposite directions:
 *
 *  1. We rewrite `Host` to `localhost:<targetPort>`. Some dev servers do
 *     DNS-rebinding host checks (Vite's `allowedHosts`, etc.) and only trust
 *     their own loopback host, so the upstream must see a loopback Host.
 *
 *  2. But frameworks that compute a *public* root URL for their frontend —
 *     Gradio is the canonical case — derive it from `X-Forwarded-Host` /
 *     `X-Forwarded-Proto`, falling back to `Host`. Without the forwarded
 *     headers, Gradio reflects the rewritten `localhost:<port>` Host and its
 *     frontend ends up calling `localhost:<port>/gradio_api/...`. In a
 *     browser-hosted ShipIt session `localhost` is the *user's* machine, not
 *     the container, so every API call fails with ERR_CONNECTION_REFUSED.
 *
 * So we preserve the browser-facing host/proto in the forwarded headers while
 * still handing the upstream a loopback Host. Existing forwarded headers (set
 * by an upstream ShipIt ingress that may also terminate TLS) win — we only
 * fill in what's missing, so a real `https` origin isn't downgraded to `http`.
 *
 * Exported for unit testing.
 */
export function buildUpstreamHeaders(
  headers: http.IncomingHttpHeaders,
  targetPort: number,
): http.IncomingHttpHeaders {
  // The browser-facing host: an upstream-provided X-Forwarded-Host wins,
  // otherwise the inbound Host (which, for our subdomain/path routing, is the
  // origin the browser actually used). Capture it before we overwrite Host.
  const browserHost = headers["x-forwarded-host"] ?? headers.host;
  const proto = headers["x-forwarded-proto"] ?? "http";

  const out: http.IncomingHttpHeaders = {
    ...headers,
    host: `localhost:${targetPort}`,
    "x-forwarded-proto": proto,
  };
  if (browserHost !== undefined) {
    out["x-forwarded-host"] = browserHost;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared proxy helpers
// ---------------------------------------------------------------------------

/**
 * Callback invoked when a preview-proxy request fails to reach the upstream
 * container. Lets the registration site emit a `preview_error` WS message
 * and a Logs entry so the user gets observable feedback instead of just a
 * blank iframe / raw 502 JSON.
 *
 * See docs/124-session-rescue-and-diagnostics §1.5.
 */
type PreviewErrorReporter = (
  sessionId: string,
  port: number,
  message: string,
  upgrade: boolean,
) => void;

function proxyHttp(
  containerIp: string,
  targetPort: number,
  targetPath: string,
  method: string,
  headers: http.IncomingHttpHeaders,
  rawReq: http.IncomingMessage,
  rawRes: http.ServerResponse,
  onError?: (message: string) => void,
): void {
  // Strip accept-encoding so the upstream sends uncompressed content — allows
  // us to inject the HMR WebSocket patch into HTML responses.
  const fwdHeaders = buildUpstreamHeaders(headers, targetPort);
  delete fwdHeaders["accept-encoding"];

  const proxyReq = http.request(
    {
      hostname: containerIp,
      port: targetPort,
      path: targetPath,
      method,
      headers: fwdHeaders,
    },
    (proxyRes) => {
      const ct = proxyRes.headers["content-type"] || "";
      const isHtml = method === "GET" && ct.includes("text/html");

      if (isHtml) {
        // Buffer HTML response, inject HMR WebSocket patch, then send.
        const chunks: Buffer[] = [];
        proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
        proxyRes.on("end", () => {
          let html = Buffer.concat(chunks).toString("utf-8");
          // Inject right after <head> (or at the start if no <head>)
          const headIdx = html.search(/<head[^>]*>/i);
          if (headIdx !== -1) {
            const insertAt = html.indexOf(">", headIdx) + 1;
            html = html.slice(0, insertAt) + HMR_WS_PATCH + html.slice(insertAt);
          } else {
            html = HMR_WS_PATCH + html;
          }
          const outHeaders = { ...proxyRes.headers };
          delete outHeaders["content-length"];
          delete outHeaders["content-encoding"];
          delete outHeaders["transfer-encoding"];
          outHeaders["content-length"] = String(Buffer.byteLength(html));
          rawRes.writeHead(proxyRes.statusCode ?? 200, outHeaders);
          rawRes.end(html);
        });
      } else {
        rawRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(rawRes);
      }
    },
  );

  proxyReq.on("error", (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (onError) onError(msg);
    if (!rawRes.headersSent) {
      rawRes.writeHead(502, { "Content-Type": "application/json" });
    }
    rawRes.end(JSON.stringify({ error: "Container preview unreachable" }));
  });

  rawReq.pipe(proxyReq);
}

function proxyWebSocket(
  containerIp: string,
  targetPort: number,
  targetPath: string,
  headers: http.IncomingHttpHeaders,
  socket: Duplex,
  onError?: (message: string) => void,
): void {
  const proxyReq = http.request({
    hostname: containerIp,
    port: targetPort,
    path: targetPath,
    method: "GET",
    headers: buildUpstreamHeaders(headers, targetPort),
  });

  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    // Forward the upstream's 101 response verbatim — includes the required
    // Sec-WebSocket-Accept header and any negotiated subprotocols.
    let head = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
    const raw = proxyRes.rawHeaders;
    for (let i = 0; i < raw.length; i += 2) {
      head += `${raw[i]}: ${raw[i + 1]}\r\n`;
    }
    head += "\r\n";
    socket.write(head);
    if (proxyHead.length > 0) socket.write(proxyHead);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);

    proxySocket.on("error", () => socket.destroy());
    socket.on("error", () => proxySocket.destroy());
    proxySocket.on("close", () => socket.destroy());
    socket.on("close", () => proxySocket.destroy());
  });

  proxyReq.on("error", (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (onError) onError(msg);
    socket.destroy();
  });

  proxyReq.end();
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Throttle window for repeated preview-proxy errors per `(sessionId,port)`
 * — a flapping dev server emits a connect-error per HTTP/HMR request and
 * we don't want to spam the Logs panel.
 */
const PREVIEW_ERROR_THROTTLE_MS = 5_000;

/**
 * Build a `PreviewErrorReporter` that routes preview-proxy connection
 * failures to (a) a `preview_error` WS message for the in-frame banner
 * and (b) a per-session `log_entry` with `source: "preview"`. Throttles
 * per `(sessionId,port)` to avoid log spam.
 *
 * Exported so the integration test in
 * `integration_tests/preview-error.test.ts` can verify the wiring without
 * spinning up the whole proxy.
 *
 * See docs/124-session-rescue-and-diagnostics §1.5.
 */
export function createPreviewErrorReporter(
  runnerRegistry: SessionRunnerRegistry | undefined,
  opts: { now?: () => number; throttleMs?: number } = {},
): PreviewErrorReporter {
  const lastErrorAt = new Map<string, number>();
  const now = opts.now ?? (() => Date.now());
  const throttleMs = opts.throttleMs ?? PREVIEW_ERROR_THROTTLE_MS;
  return (sessionId, port, message, upgrade) => {
    if (!runnerRegistry) return;
    const runner = runnerRegistry.get(sessionId);
    if (!runner) return;
    const key = `${sessionId}:${port}`;
    const t = now();
    const last = lastErrorAt.get(key) ?? 0;
    if (t - last < throttleMs) return;
    lastErrorAt.set(key, t);
    const human = upgrade
      ? `Preview HMR unreachable on port ${port} (${message})`
      : `Preview unreachable on port ${port} (${message})`;
    runner.emitMessage({
      type: "preview_error",
      sessionId,
      port,
      message,
      upgrade,
    });
    runner.emitMessage({
      type: "log_entry",
      source: "preview",
      text: human,
      timestamp: new Date(t).toISOString(),
    });
  };
}

export function registerPreviewProxy(
  app: FastifyInstance,
  opts: {
    containerManager: SessionContainerManager;
    serviceManagers: Map<string, ServiceManager>;
    /**
     * Optional runner registry. When provided, proxy errors emit a
     * `preview_error` runner event so connected viewers see an inline
     * "Preview unreachable on port N" overlay, and a `log_entry` so the
     * Logs panel records the failure. Without this, proxy errors are
     * iframe-only — the orchestrator side has no record. See
     * docs/124-session-rescue-and-diagnostics §1.5.
     */
    runnerRegistry?: SessionRunnerRegistry;
  },
): void {
  const { containerManager, serviceManagers, runnerRegistry } = opts;

  const reportError = createPreviewErrorReporter(runnerRegistry);

  /**
   * Resolve the container IP for a session + port combination.
   * Checks compose service containers first (by port), falls back to agent container.
   */
  function resolveContainerIp(sessionId: string, port: number): string | null {
    // Check compose services for a container listening on this port
    const mgr = serviceManagers.get(sessionId);
    if (mgr) {
      const ip = mgr.getContainerIpForPort(port);
      if (ip) return ip;
    }
    // Fall back to the agent container
    const sc = containerManager.get(sessionId);
    return sc?.containerIp ?? null;
  }

  // --- Subdomain-based proxy (intercepts before Fastify routing) ----------
  //
  // When Host matches {uuid}--{port}.*, proxy the entire request to the
  // container. This lets the dev server's absolute paths (/src/main.tsx)
  // resolve naturally — no HTML rewriting needed.

  app.addHook("onRequest", (request, reply, done) => {
    const parsed = parsePreviewSubdomain(request.headers.host);
    if (!parsed) {
      done(); // Not a preview subdomain — continue normal routing
      return;
    }

    const { sessionId, port: targetPort } = parsed;
    const containerIp = resolveContainerIp(sessionId, targetPort);
    if (!containerIp) {
      reply.code(404).send({ error: "Session container not found" });
      done();
      return;
    }

    reply.hijack();
    proxyHttp(
      containerIp,
      targetPort,
      request.url,
      request.method,
      request.headers,
      request.raw,
      reply.raw,
      (msg) => reportError(sessionId, targetPort, msg, false),
    );
    done();
  });

  // --- Preview health check (for polling without console errors) ----------
  //
  // Always returns 200 with { ready: true/false }. The browser logs non-2xx
  // fetch() responses as errors in the console; this endpoint avoids that.

  app.get(
    "/api/preview-health/:sessionId/:port",
    async (request, reply) => {
      const params = request.params as { sessionId: string; port: string };
      const targetPort = Number(params.port);
      if (
        !Number.isInteger(targetPort) ||
        targetPort < 1 ||
        targetPort > 65535
      ) {
        return reply.send({ ready: false });
      }
      const containerIp = resolveContainerIp(params.sessionId, targetPort);
      if (!containerIp) {
        return reply.send({ ready: false });
      }
      // Quick HTTP probe to the container's dev server
      const ready = await new Promise<boolean>((resolve) => {
        const probe = http.request(
          {
            hostname: containerIp,
            port: targetPort,
            path: "/",
            method: "HEAD",
            timeout: 2000,
          },
          (res) => {
            res.resume();
            resolve(
              res.statusCode !== undefined && res.statusCode < 500,
            );
          },
        );
        probe.on("error", () => resolve(false));
        probe.on("timeout", () => {
          probe.destroy();
          resolve(false);
        });
        probe.end();
      });
      return reply.send({ ready });
    },
  );

  // --- WebSocket upgrade proxy (subdomain) -------------------------------
  //
  // @fastify/websocket registers its own `upgrade` listener (for /ws).
  // Both listeners fire for every upgrade request. For preview WebSockets,
  // Fastify's handler finds no matching route and destroys the socket before
  // our proxy can use it. Fix: take over the upgrade event — handle preview
  // WebSockets ourselves, delegate everything else to the original handlers.

  const originalUpgradeListeners = [
    ...app.server.listeners("upgrade"),
  ] as ((...args: unknown[]) => void)[];
  app.server.removeAllListeners("upgrade");

  app.server.on(
    "upgrade",
    (
      req: http.IncomingMessage,
      socket: Duplex,
      head: Buffer,
    ) => {
      // Try subdomain-based first
      const subdomainParsed = parsePreviewSubdomain(req.headers.host);
      if (subdomainParsed) {
        const { sessionId, port: targetPort } = subdomainParsed;
        const containerIp = resolveContainerIp(sessionId, targetPort);
        if (!containerIp) {
          reportError(sessionId, targetPort, "Container not found for HMR upgrade", true);
          socket.destroy();
          return;
        }
        proxyWebSocket(
          containerIp,
          targetPort,
          req.url || "/",
          req.headers,
          socket,
          (msg) => reportError(sessionId, targetPort, msg, true),
        );
        return;
      }

      // Not a preview WebSocket — forward to original handlers (Fastify /ws)
      for (const listener of originalUpgradeListeners) {
        listener.call(app.server, req, socket, head);
      }
    },
  );
}
