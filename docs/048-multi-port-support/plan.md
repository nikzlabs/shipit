---
status: planned
---

# 048 — Multi-Port Preview Support

## Problem

ShipIt runs inside a Docker container that only publishes ports 3000 (Fastify) and 5173 (Vite preview). When a user's app starts additional dev servers (e.g., Express API on 8080, docs server on 4000), the port scanner detects them inside the container and the UI shows them in the port dropdown — but the browser iframe can't reach them because those ports are never published to the host.

```
Browser (host)                    Docker Container
─────────────────                 ─────────────────
iframe → localhost:5173  ──────→  Vite preview (5173)     OK — published
iframe → localhost:3000  ──────→  Fastify server (3000)   OK — published
iframe → localhost:8080  ──X───→  User's API (8080)       BROKEN — not published
```

## Solution: Reverse Proxy Through Fastify

Route all preview traffic through the already-published Fastify server on port 3000 using path-based proxying. Each internal port gets a path prefix:

```
Browser → localhost:3000/preview/8080/path → Fastify proxy → 127.0.0.1:8080/path
```

This eliminates the need for Docker port publishing, works in any deployment topology (Docker, Kubernetes, cloud VMs), and as a bonus puts all preview traffic on the same origin — solving CORS issues between frontend and API.

### Why not alternatives?

| Approach | Problem |
|---|---|
| Publish a port range (`3000-9000:3000-9000`) | Conflicts in multi-tenant, doesn't cover arbitrary ports, wastes host resources |
| `--network=host` | Linux-only, no isolation, conflicts with host services |
| Dynamic Docker API port publishing | Docker doesn't support adding ports to running containers |

## Design

### URL scheme

```
/preview/{port}/{path...}
```

- `{port}` — the target port inside the container (validated against known ports)
- `{path...}` — everything after the prefix, forwarded verbatim including query string
- WebSocket upgrade requests on the same path are proxied transparently

Examples:
```
GET  /preview/5173/              →  GET  http://127.0.0.1:5173/
GET  /preview/8080/api/users     →  GET  http://127.0.0.1:8080/api/users
WS   /preview/5173/              →  WS   ws://127.0.0.1:5173/         (Vite HMR)
WS   /preview/8080/socket.io/   →  WS   ws://127.0.0.1:8080/socket.io/
```

### Security: Port allowlist

The proxy must not become an open relay to any port on the machine. Only proxy to ports that ShipIt knows about:

```typescript
function isAllowedPort(port: number, runner: SessionRunner | null, globalPorts: number[]): boolean {
  // Managed preview ports (from PreviewManager)
  // Detected ports (from port scanner)
  // Explicitly configured ports (from shipit.yaml)
  // Reject everything else
}
```

Requests to unknown ports get a `403 Forbidden`.

### Architecture overview

```
                    Fastify (:3000)
                    ┌─────────────────────────────────────────┐
                    │                                         │
  /api/*         ───┤  api-routes.ts (existing HTTP routes)   │
                    │                                         │
  /ws            ───┤  index.ts (existing WebSocket handler)  │
                    │                                         │
  /preview/:port ───┤  preview-proxy.ts (NEW)                 │──→ 127.0.0.1:{port}
                    │  ├─ HTTP requests: strip prefix, proxy  │
                    │  └─ WS upgrade: strip prefix, pipe      │
                    │                                         │
  /*             ───┤  @fastify/static (SPA fallback)         │
                    └─────────────────────────────────────────┘
```

### WebSocket proxying

WebSocket support is critical — Vite HMR, Webpack HMR, Next.js hot reload, and user app WebSockets all need to work.

**How it works:**

1. Browser opens `ws://localhost:3000/preview/5173/` (HTTP Upgrade request)
2. Fastify intercepts the Upgrade before it hits `@fastify/websocket`
3. Proxy strips the `/preview/5173` prefix → opens `ws://127.0.0.1:5173/`
4. Bidirectional pipe between the two sockets

**Why Vite HMR works without config changes:**

Vite's client reads its WebSocket URL from the page's origin. When the page loads from `/preview/5173/`, the HMR client connects to `ws://localhost:3000/preview/5173/` (same host, same path prefix). The proxy strips the prefix and forwards to `ws://127.0.0.1:5173/` — Vite's server sees a normal `/` WebSocket connection.

However, Vite hardcodes the HMR WebSocket path (typically just `/` or `/__vite_hmr`). If Vite's client opens `ws://localhost:3000/` instead of `ws://localhost:3000/preview/5173/`, HMR will fail. We handle this in two ways:

1. **Preferred**: Configure `server.hmr.clientPort` and `server.hmr.path` in the wrapper config that ShipIt already writes to `.shipit/vite.config.mjs`. This tells Vite's client exactly where to connect.
2. **Fallback for non-Vite frameworks**: Most frameworks (Next.js, Webpack, Remix) derive HMR connection from `window.location`, which already points to the proxied URL. No config needed.

### Implementation: `node:http` proxy (no new dependency)

Rather than adding `@fastify/http-proxy` (which brings `fast-proxy` + `undici` transitive deps), we use Node's built-in `node:http` module. The proxy logic is straightforward (~100 lines) and gives us full control over WebSocket upgrade handling.

#### HTTP proxy

```typescript
// src/server/preview-proxy.ts

import http from "node:http";
import type { FastifyInstance } from "fastify";

export function registerPreviewProxy(
  app: FastifyInstance,
  opts: { isPortAllowed: (port: number) => boolean },
): void {
  // Wildcard route catches all /preview/:port/* requests
  app.all("/preview/:port/*", async (request, reply) => {
    const port = Number((request.params as { port: string }).port);
    if (!Number.isInteger(port) || !opts.isPortAllowed(port)) {
      return reply.code(403).send({ error: "Port not allowed" });
    }

    // Strip the /preview/{port} prefix from the URL
    const target = request.url.replace(`/preview/${port}`, "") || "/";

    // Forward via http.request
    const proxyReq = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: target,
        method: request.method,
        headers: { ...request.headers, host: `localhost:${port}` },
      },
      (proxyRes) => {
        reply.raw.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(reply.raw);
      },
    );

    proxyReq.on("error", () => {
      if (!reply.sent) reply.code(502).send({ error: "Upstream unreachable" });
    });

    request.raw.pipe(proxyReq);
  });
}
```

#### WebSocket proxy

WebSocket upgrade happens at the raw HTTP server level, before Fastify's routing. We hook into `server.on("upgrade")`:

```typescript
export function registerPreviewWsProxy(
  server: http.Server,
  opts: { isPortAllowed: (port: number) => boolean },
): void {
  server.on("upgrade", (req, socket, head) => {
    const match = req.url?.match(/^\/preview\/(\d+)(\/.*)?$/);
    if (!match) return; // Not a preview proxy request — let Fastify handle it

    const port = Number(match[1]);
    if (!opts.isPortAllowed(port)) {
      socket.destroy();
      return;
    }

    const targetPath = match[2] || "/";

    // Open upstream WebSocket connection
    const proxyReq = http.request({
      hostname: "127.0.0.1",
      port,
      path: targetPath,
      method: "GET",
      headers: { ...req.headers, host: `localhost:${port}` },
    });

    proxyReq.on("upgrade", (_proxyRes, proxySocket, proxyHead) => {
      // Send the 101 Switching Protocols response to the client
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        // Forward Sec-WebSocket-Accept and other headers from upstream
        "\r\n",
      );

      if (proxyHead.length) proxySocket.unshift(proxyHead);
      if (head.length) socket.unshift(head);

      // Bidirectional pipe
      socket.pipe(proxySocket).pipe(socket);

      socket.on("error", () => proxySocket.destroy());
      proxySocket.on("error", () => socket.destroy());
    });

    proxyReq.on("error", () => socket.destroy());
    proxyReq.end();
  });
}
```

**Important**: The `upgrade` listener must be registered **before** `@fastify/websocket`'s listener, or it must check the URL prefix and only handle `/preview/*` requests, letting `/ws` fall through to the existing handler.

### Client changes

#### PreviewFrame URL construction

```typescript
// Before:
const activeUrl = `http://localhost:${activePort}`;

// After:
const activeUrl = `/preview/${activePort}/`;
```

This makes the iframe same-origin with the ShipIt app, which:
- Fixes Docker networking (all traffic through port 3000)
- Preserves `postMessage` error capture (same origin)
- Enables cross-service API calls (same origin = no CORS)

#### Port polling

```typescript
// Before:
await fetch(`http://localhost:${activePort}`, { mode: "no-cors" });

// After:
await fetch(`/preview/${activePort}/`, { mode: "no-cors" });
```

#### WsPreviewStatus `url` field

The server's `buildPreviewStatus()` currently returns `url: "http://localhost:${port}"`. This changes to:

```typescript
url: `/preview/${port}/`
```

The client should prefer computing the URL from the port (as it already does), but updating the server-sent URL keeps things consistent.

### postMessage error capture

Currently, the error-capture script injected by `vite-error-plugin.ts` uses `window.parent.postMessage(data, '*')`, and the parent listens with `window.addEventListener("message", handler)`. The parent filters by `data.source === 'shipit-preview'`.

**With the proxy, this continues to work because:**
- The iframe loads from `/preview/5173/` which is same-origin (`localhost:3000`)
- `postMessage` with `'*'` targetOrigin works regardless
- The `source: 'shipit-preview'` filter is origin-independent

**No changes needed to the error capture system.**

### Vite HMR configuration

ShipIt already writes a wrapper Vite config to `.shipit/vite.config.mjs` for HTML-mode previews. We add HMR settings:

```javascript
// In preview-manager.ts, the generated wrapper config
export default defineConfig({
  plugins: [shipitErrorCapture(), ...(userConfig?.plugins || [])],
  server: {
    hmr: {
      // Tell Vite's client to connect via the proxy path
      path: "/preview/5173/",
      clientPort: 3000,
    },
  },
});
```

For command-mode previews (user's own Vite), we can set the `VITE_HMR_CLIENT_PORT` env var or rely on the fact that most frameworks derive HMR connection from `window.location`.

**Fallback**: If HMR breaks for a specific framework, the user can configure it manually in their own Vite/Webpack config. This is an edge case we document, not a blocker.

### Testing strategy

#### Unit tests (`src/server/preview-proxy.test.ts`)

- Port validation (valid integer, within range, allowed vs. rejected)
- Path stripping (`/preview/8080/api/users` → `/api/users`)
- Edge cases: no trailing path, query strings, encoded characters
- 403 for disallowed ports, 502 for unreachable upstream

#### Integration tests (`src/server/integration_tests/preview-proxy.test.ts`)

Using `buildApp()` with injected stubs:

1. **HTTP proxy happy path**: Start a simple HTTP server on an ephemeral port, register it as allowed, verify `GET /preview/{port}/path` returns upstream response
2. **WebSocket proxy**: Open a WS connection to `/preview/{port}/`, verify bidirectional message delivery
3. **Port allowlist enforcement**: Verify 403 for unregistered ports
4. **502 on unreachable upstream**: Verify graceful error when upstream is down
5. **Path and query string preservation**: Verify `/preview/8080/a/b?c=d` → `/a/b?c=d`

#### Client tests

- Update `PreviewFrame.test.tsx` to verify URLs use `/preview/{port}/` format
- Verify polling hits proxy path, not `http://localhost:{port}`

### Migration / backward compatibility

The change to proxy URLs is **internal only** — no user-facing config changes. The `WsPreviewStatus.url` field changes format, but the client already computes URLs from the port number. The field is informational.

**Docker**: No changes to `Dockerfile.dev` or `docker-compose.yml`. Port 5173 can remain exposed for direct Vite HMR access during development, but is no longer required for preview to work.

### Rollout

Phase 1 (this feature):
1. Add `preview-proxy.ts` with HTTP + WS proxying
2. Wire port allowlist to scanner + preview manager
3. Update client to use `/preview/{port}/` URLs
4. Update Vite wrapper config with HMR settings
5. Tests

Phase 2 (future, optional):
- Named port labels in `shipit.yaml` (`port: 8080, label: "API"`)
- Tabbed multi-preview UI (multiple iframes side by side)
- Broader port detection via `/proc/net/tcp` instead of hardcoded list

## Key files

| File | Change |
|---|---|
| `src/server/preview-proxy.ts` | **NEW** — HTTP + WS proxy logic |
| `src/server/index.ts` | Register proxy plugin, wire port allowlist |
| `src/server/session-runner.ts` | Update `buildPreviewStatus()` URL format |
| `src/client/components/PreviewFrame.tsx` | Use `/preview/{port}/` URLs |
| `src/server/preview-manager.ts` | Add HMR config to Vite wrapper |
| `src/server/types/ws-server-messages.ts` | Update `url` field docs |
| `src/server/integration_tests/preview-proxy.test.ts` | **NEW** — proxy integration tests |
| `src/server/preview-proxy.test.ts` | **NEW** — proxy unit tests |
| `src/client/components/PreviewFrame.test.tsx` | Update URL assertions |
