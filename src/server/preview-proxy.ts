/**
 * Preview Proxy — session-ID-based reverse proxy for preview traffic.
 *
 * Routes GET/POST /preview/:sessionId/:port/* to the container's bridge IP.
 * Supports WebSocket upgrades for HMR (hot module replacement).
 *
 * Only registered when useContainers is true and a SessionContainerManager
 * is available.
 */

import http from "node:http";
import type { FastifyInstance } from "fastify";
import type { SessionContainerManager } from "./session-container.js";

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

  // --- HTTP proxy for all methods ---

  app.all("/preview/:sessionId/:port/*", async (request, reply) => {
    const params = request.params as { sessionId: string; port: string; "*": string };
    const { sessionId } = params;
    const portStr = params.port;
    const targetPort = Number(portStr);

    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      return reply.code(400).send({ error: "Invalid port" });
    }

    const sc = containerManager.get(sessionId);
    if (!sc) {
      return reply.code(404).send({ error: "Session container not found" });
    }

    // Build the target path (strip the /preview/{sessionId}/{port} prefix)
    const wildcard = params["*"] || "";
    const queryString = request.url.includes("?")
      ? "?" + request.url.split("?").slice(1).join("?")
      : "";
    const targetPath = `/${wildcard}${queryString}`;

    // Proxy the request
    reply.hijack();

    const proxyReq = http.request(
      {
        hostname: sc.containerIp,
        port: targetPort,
        path: targetPath,
        method: request.method,
        headers: {
          ...request.headers,
          host: `localhost:${targetPort}`,
        },
      },
      (proxyRes) => {
        reply.raw.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(reply.raw);
      },
    );

    proxyReq.on("error", () => {
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(502, { "Content-Type": "application/json" });
      }
      reply.raw.end(JSON.stringify({ error: "Container preview unreachable" }));
    });

    request.raw.pipe(proxyReq);
  });

  // --- WebSocket upgrade proxy for HMR ---

  app.server.on("upgrade", (req, socket, _head) => {
    const match = req.url?.match(/^\/preview\/([^/]+)\/(\d+)\/(.*)/);
    if (!match) return; // Not a preview WebSocket — let the default handler proceed

    const [, sessionId, portStr, restPath] = match;
    const targetPort = Number(portStr);

    const sc = containerManager.get(sessionId);
    if (!sc) {
      socket.destroy();
      return;
    }

    const proxyReq = http.request({
      hostname: sc.containerIp,
      port: targetPort,
      path: `/${restPath}`,
      method: "GET",
      headers: {
        ...req.headers,
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

      // Clean up on either side closing
      proxySocket.on("error", () => socket.destroy());
      socket.on("error", () => proxySocket.destroy());
      proxySocket.on("close", () => socket.destroy());
      socket.on("close", () => proxySocket.destroy());
    });

    proxyReq.on("error", () => {
      socket.destroy();
    });

    proxyReq.end();
  });
}
