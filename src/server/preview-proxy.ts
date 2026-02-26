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
 * Only registered when useContainers is true and a SessionContainerManager
 * is available.
 */

import http from "node:http";
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
  const match = hostname.match(
    /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})--(\d+)\./i,
  );
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { sessionId: match[1], port };
}

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
  const proxyReq = http.request(
    {
      hostname: containerIp,
      port: targetPort,
      path: targetPath,
      method,
      headers: {
        ...headers,
        host: `localhost:${targetPort}`,
      },
    },
    (proxyRes) => {
      rawRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(rawRes);
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
  socket: import("node:stream").Duplex,
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

  proxyReq.on("upgrade", (_proxyRes, proxySocket, proxyHead) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "\r\n",
    );
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
      ? "?" + request.url.split("?").slice(1).join("?")
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

  app.server.on("upgrade", (req, socket, _head) => {
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
    if (!match) return; // Not a preview WebSocket — let default handler proceed

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
  });
}
