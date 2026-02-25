import http from "node:http";
import type { Socket } from "node:net";
import type { FastifyInstance } from "fastify";

/**
 * Validate and extract the port from route params.
 * Returns the port number if valid and allowed, or null otherwise.
 */
function validatePort(
  params: { port: string },
  isPortAllowed: (port: number) => boolean,
): number | null {
  const port = Number(params.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !isPortAllowed(port)) {
    return null;
  }
  return port;
}

/**
 * Strip the `/preview/{port}` prefix from a request URL.
 */
export function stripPreviewPrefix(url: string, port: number): string {
  return url.replace(`/preview/${port}`, "") || "/";
}

/**
 * Register the preview proxy routes on the Fastify app.
 *
 * Proxies HTTP requests from `/preview/:port/*` to `127.0.0.1:{port}`,
 * stripping the `/preview/{port}` prefix. This allows all preview traffic
 * to flow through the single published Fastify port (3000), solving Docker
 * networking issues where internal container ports are not published to the host.
 */
const PROXY_TIMEOUT_MS = 30_000;

export function registerPreviewProxy(
  app: FastifyInstance,
  opts: { isPortAllowed: (port: number) => boolean },
): void {
  // Encapsulate so the wildcard content-type parser only applies to proxy routes
  app.register(async (scope) => {
    // Disable Fastify's default body parsing for proxy routes —
    // we forward the raw body stream directly to the upstream.
    scope.addContentTypeParser("*", (_request, _payload, done) => {
      done(null);
    });

    // Match /preview/:port with a trailing path
    scope.all("/preview/:port/*", async (request, reply) => {
      const port = validatePort(request.params as { port: string }, opts.isPortAllowed);
      if (port === null) {
        return reply.code(403).send({ error: "Port not allowed" });
      }

      const target = stripPreviewPrefix(request.url, port);

      // Collect the request body chunks if present
      const bodyChunks: Buffer[] = [];
      for await (const chunk of request.raw) {
        bodyChunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(bodyChunks);

      const headers: Record<string, string | string[] | undefined> = { ...request.headers };
      headers.host = `localhost:${port}`;
      delete headers["transfer-encoding"];
      // Set correct content-length for the forwarded body
      if (body.length > 0) {
        headers["content-length"] = String(body.length);
      }

      return new Promise<void>((resolve) => {
        const proxyReq = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: target,
            method: request.method,
            headers,
            timeout: PROXY_TIMEOUT_MS,
          },
          (proxyRes) => {
            // Forward status and headers from upstream
            reply.hijack();
            reply.raw.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
            proxyRes.pipe(reply.raw);
            proxyRes.on("end", resolve);
          },
        );

        proxyReq.on("timeout", () => {
          proxyReq.destroy();
        });

        proxyReq.on("error", () => {
          if (!reply.sent) {
            reply.code(502).send({ error: "Upstream unreachable" });
          }
          resolve();
        });

        if (body.length > 0) {
          proxyReq.write(body);
        }
        proxyReq.end();
      });
    });

    // Handle bare /preview/:port (no trailing slash) — redirect to /preview/:port/
    scope.all("/preview/:port", async (request, reply) => {
      const port = validatePort(request.params as { port: string }, opts.isPortAllowed);
      if (port === null) {
        return reply.code(403).send({ error: "Port not allowed" });
      }
      return reply.redirect(`/preview/${port}/`);
    });
  });
}

/**
 * Register the WebSocket proxy for preview connections.
 *
 * Intercepts HTTP Upgrade requests on `/preview/:port/*` and pipes them
 * to the upstream WebSocket server at `127.0.0.1:{port}`. This enables
 * Vite HMR, Webpack HMR, and other WebSocket-based dev tooling to work
 * through the proxy.
 *
 * **Important**: This must be registered before `@fastify/websocket`'s
 * upgrade listener to ensure preview WS requests are handled here and
 * `/ws` requests fall through to the existing handler.
 */
export function registerPreviewWsProxy(
  server: http.Server,
  opts: { isPortAllowed: (port: number) => boolean },
): void {
  // Prepend our listener so it fires before @fastify/websocket
  const existingListeners = server.listeners("upgrade") as ((...args: unknown[]) => void)[];
  server.removeAllListeners("upgrade");

  const previewUpgradeHandler = (req: http.IncomingMessage, socket: Socket, head: Buffer) => {
    const match = req.url?.match(/^\/preview\/(\d+)(\/.*)?$/);
    if (!match) return false; // Not a preview proxy request

    const port = Number(match[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !opts.isPortAllowed(port)) {
      socket.destroy();
      return true;
    }

    const targetPath = match[2] || "/";

    // Open upstream WebSocket connection via HTTP upgrade
    const proxyReq = http.request({
      hostname: "127.0.0.1",
      port,
      path: targetPath,
      method: "GET",
      headers: { ...req.headers, host: `localhost:${port}` },
    });

    proxyReq.on("upgrade", (_proxyRes, proxySocket, proxyHead) => {
      // Forward the raw 101 response headers from upstream to the client
      const statusLine = "HTTP/1.1 101 Switching Protocols\r\n";
      const headerLines: string[] = [];
      if (_proxyRes.headers["upgrade"]) {
        headerLines.push(`Upgrade: ${_proxyRes.headers["upgrade"]}`);
      }
      if (_proxyRes.headers["connection"]) {
        headerLines.push(`Connection: ${_proxyRes.headers["connection"]}`);
      }
      if (_proxyRes.headers["sec-websocket-accept"]) {
        headerLines.push(`Sec-WebSocket-Accept: ${_proxyRes.headers["sec-websocket-accept"]}`);
      }
      if (_proxyRes.headers["sec-websocket-protocol"]) {
        headerLines.push(`Sec-WebSocket-Protocol: ${_proxyRes.headers["sec-websocket-protocol"]}`);
      }

      socket.write(statusLine + headerLines.join("\r\n") + "\r\n\r\n");

      if (proxyHead.length) proxySocket.unshift(proxyHead);
      if (head.length) socket.unshift(head);

      // Bidirectional pipe
      socket.pipe(proxySocket).pipe(socket);

      socket.on("error", () => proxySocket.destroy());
      proxySocket.on("error", () => socket.destroy());
      socket.on("close", () => proxySocket.destroy());
      proxySocket.on("close", () => socket.destroy());
    });

    proxyReq.on("error", () => socket.destroy());
    proxyReq.end();
    return true;
  };

  // Install a combined handler: try preview first, then fall through to existing
  server.on("upgrade", (req: http.IncomingMessage, socket: Socket, head: Buffer) => {
    if (previewUpgradeHandler(req, socket, head)) return;
    // Not a preview request — forward to existing listeners
    for (const listener of existingListeners) {
      listener(req, socket, head);
    }
  });
}
