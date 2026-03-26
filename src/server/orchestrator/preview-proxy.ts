/**
 * Preview Proxy — session-ID-based reverse proxy for preview traffic.
 *
 * Primary: Subdomain routing — {sessionId}--{port}.localhost routes ALL
 * requests to the container's bridge IP. Absolute paths (/src/main.tsx,
 * /@vite/client) resolve naturally against the subdomain origin without
 * any HTML rewriting — works with any dev server, not just Vite.
 *
 * Fallback: Path-based routing — /preview/:sessionId/:port/* strips the
 * prefix and proxies to the container. Used for polling and diagnostics.
 *
 * Supports WebSocket upgrades for HMR in both modes.
 *
 * Registered when a SessionContainerManager is available (production mode).
 */

import http from "node:http";
import type { Duplex } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { SessionContainerManager } from "./session-container.js";

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
// Shared proxy helpers
// ---------------------------------------------------------------------------

function proxyHttp(
  containerIp: string,
  targetPort: number,
  targetPath: string,
  method: string,
  headers: http.IncomingHttpHeaders,
  rawReq: http.IncomingMessage,
  rawRes: http.ServerResponse,
): void {
  // Strip accept-encoding so the upstream sends uncompressed content — allows
  // us to inject the HMR WebSocket patch into HTML responses.
  const fwdHeaders = { ...headers, host: `localhost:${targetPort}` };
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

  proxyReq.on("error", () => {
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
): void {
  const proxyReq = http.request({
    hostname: containerIp,
    port: targetPort,
    path: targetPath,
    method: "GET",
    headers: {
      ...headers,
      host: `localhost:${targetPort}`,
    },
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

  proxyReq.on("error", () => {
    socket.destroy();
  });

  proxyReq.end();
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerPreviewProxy(
  app: FastifyInstance,
  opts: {
    containerManager: SessionContainerManager;
  },
): void {
  const { containerManager } = opts;

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
    const sc = containerManager.get(sessionId);
    if (!sc) {
      reply.code(404).send({ error: "Session container not found" });
      done();
      return;
    }

    reply.hijack();
    proxyHttp(
      sc.containerIp,
      targetPort,
      request.url,
      request.method,
      request.headers,
      request.raw,
      reply.raw,
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
      const sc = containerManager.get(params.sessionId);
      if (!sc) {
        return reply.send({ ready: false });
      }
      // Quick HTTP probe to the container's dev server (route to preview container)
      const ready = await new Promise<boolean>((resolve) => {
        const probe = http.request(
          {
            hostname: sc.containerIp,
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

  // --- Path-based HTTP proxy (fallback) -----------------------------------

  app.all("/preview/:sessionId/:port/*", async (request, reply) => {
    const params = request.params as {
      sessionId: string;
      port: string;
      "*": string;
    };
    const { sessionId } = params;
    const targetPort = Number(params.port);

    if (
      !Number.isInteger(targetPort) ||
      targetPort < 1 ||
      targetPort > 65535
    ) {
      return reply.code(400).send({ error: "Invalid port" });
    }

    const sc = containerManager.get(sessionId);
    if (!sc) {
      return reply.code(404).send({ error: "Session container not found" });
    }

    const wildcard = params["*"] || "";
    const queryString = request.url.includes("?")
      ? `?${  request.url.split("?").slice(1).join("?")}`
      : "";
    const targetPath = `/${wildcard}${queryString}`;

    reply.hijack();
    proxyHttp(
      sc.containerIp,
      targetPort,
      targetPath,
      request.method,
      request.headers,
      request.raw,
      reply.raw,
    );
  });

  // --- WebSocket upgrade proxy (subdomain + path-based) -------------------
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
        const sc = containerManager.get(sessionId);
        if (!sc) {
          socket.destroy();
          return;
        }
        proxyWebSocket(
          sc.containerIp,
          targetPort,
          req.url || "/",
          req.headers,
          socket,
        );
        return;
      }

      // Try path-based
      const match = req.url?.match(/^\/preview\/([^/]+)\/(\d+)\/(.*)/);
      if (match) {
        const [, sessionId, portStr, restPath] = match;
        const targetPort = Number(portStr);
        const sc = containerManager.get(sessionId);
        if (!sc) {
          socket.destroy();
          return;
        }
        proxyWebSocket(
          sc.containerIp,
          targetPort,
          `/${restPath}`,
          req.headers,
          socket,
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
