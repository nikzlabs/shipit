/**
 * Docker API proxy — sits between session containers and the host Docker daemon.
 *
 * Sessions get a real Docker CLI but no Docker socket. Instead, `DOCKER_HOST`
 * points to this proxy, which enforces policy (no --privileged, no host mounts,
 * etc.) and scopes resources by session via labels.
 *
 * The proxy identifies sessions by the source IP of the TCP connection — each
 * session container has a unique bridge IP. Source-IP spoofing is prevented by
 * dropping `NET_RAW` from session containers.
 */

import http from "node:http";

import {
  respond,
  forbidden,
  badRequest,
  readBody,
  forwardToDocker,
  pipeToDocker,
  PARENT_SESSION_LABEL,
  MAX_BODY_SIZE,
  DOCKER_SOCKET,
  CONTAINER_NAME_RE,
} from "./docker-proxy-helpers.js";
import type { DockerProxyDeps, Route, RequestContext } from "./docker-proxy-helpers.js";
import {
  containerBelongsToSession,
  networkBelongsToSession,
  volumeBelongsToSession,
  getExecParentContainerId,
} from "./docker-proxy-auth.js";
import { sanitizeContainerCreate } from "./docker-proxy-sanitize.js";

// ---------------------------------------------------------------------------
// Re-exports for backwards compatibility
// ---------------------------------------------------------------------------

export {
  respond,
  forbidden,
  badRequest,
  readBody,
  forwardToDocker,
  pipeToDocker,
  PARENT_SESSION_LABEL,
  MAX_BODY_SIZE,
  DOCKER_SOCKET,
  CONTAINER_NAME_RE,
} from "./docker-proxy-helpers.js";
export type {
  SessionInfo,
  DockerProxyDeps,
  Route,
  RequestContext,
} from "./docker-proxy-helpers.js";
export {
  containerBelongsToSession,
  networkBelongsToSession,
  volumeBelongsToSession,
  getExecParentContainerId,
  isPathUnderWorkspace,
} from "./docker-proxy-auth.js";
export { sanitizeContainerCreate } from "./docker-proxy-sanitize.js";

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

function buildRoutes(): Route[] {
  const routes: Route[] = [];

  // Helper to add routes
  function route(method: string, pattern: RegExp, handler: Route["handler"]): void {
    routes.push({ method, pattern, handler });
  }

  // ---- Container lifecycle ----

  // POST /containers/create
  route("POST", /^\/v[\d.]+\/containers\/create(\?.*)?$|^\/containers\/create(\?.*)?$/, async (ctx) => {
    try {
      const bodyBuf = await readBody(ctx.req, MAX_BODY_SIZE);
      const body = JSON.parse(bodyBuf.toString()) as Record<string, unknown>;

      const result = await sanitizeContainerCreate(body, ctx.session, ctx.socketPath);
      if (result.error) {
        forbidden(ctx.res, result.error); return;
      }

      const sanitizedBody = Buffer.from(JSON.stringify(body));
      const dockerResult = await forwardToDocker(
        ctx.socketPath,
        "POST",
        ctx.req.url!,
        { "content-type": "application/json" },
        sanitizedBody,
      );

      ctx.res.writeHead(dockerResult.statusCode, dockerResult.headers);
      ctx.res.end(dockerResult.body);
    } catch (err) {
      if ((err as Error).message === "Request body too large") {
        badRequest(ctx.res, "Request body too large (max 10 MB)");
      } else {
        badRequest(ctx.res, (err as Error).message);
      }
    }
  });

  // GET /containers/json — filter to session-labeled containers
  route("GET", /^\/v[\d.]+\/containers\/json(\?.*)?$|^\/containers\/json(\?.*)?$/, async (ctx) => {
    const dockerResult = await forwardToDocker(ctx.socketPath, "GET", ctx.req.url!, ctx.req.headers as Record<string, string>);
    if (dockerResult.statusCode !== 200) {
      ctx.res.writeHead(dockerResult.statusCode, dockerResult.headers);
      ctx.res.end(dockerResult.body);
      return;
    }

    const containers = JSON.parse(dockerResult.body.toString()) as Record<string, unknown>[];
    const filtered = containers.filter((c) => {
      const labels = c.Labels as Record<string, string> | undefined;
      return labels?.[PARENT_SESSION_LABEL] === ctx.session.sessionId;
    });

    respond(ctx.res, 200, filtered);
  });

  // Container operations that need label check
  const containerLabelOps: { method: string; suffix: string }[] = [
    { method: "GET", suffix: "/json" },
    { method: "POST", suffix: "/start" },
    { method: "POST", suffix: "/stop" },
    { method: "POST", suffix: "/restart" },
    { method: "POST", suffix: "/kill" },
    { method: "DELETE", suffix: "" },
    { method: "POST", suffix: "/wait" },
  ];

  for (const op of containerLabelOps) {
    const escapedSuffix = op.suffix.replace(/\//g, "\\/");
    const pattern = new RegExp(
      `^(?:\\/v[\\d.]+)?\\/containers\\/(${CONTAINER_NAME_RE})${escapedSuffix}(\\?.*)?$`,
    );
    route(op.method, pattern, async (ctx, match) => {
      const containerId = match[1];
      if (!(await containerBelongsToSession(ctx.socketPath, containerId, ctx.session.sessionId))) {
        forbidden(ctx.res, "Container does not belong to this session"); return;
      }
      pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
    });
  }

  // ---- Container I/O (label-scoped, some streaming) ----

  // GET /containers/{id}/logs — streaming
  route("GET", /^(?:\/v[\d.]+)?\/containers\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)\/logs(\?.*)?$/, async (ctx, match) => {
    const containerId = match[1];
    if (!(await containerBelongsToSession(ctx.socketPath, containerId, ctx.session.sessionId))) {
      forbidden(ctx.res, "Container does not belong to this session"); return;
    }
    pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  // POST /containers/{id}/attach — streaming
  route("POST", /^(?:\/v[\d.]+)?\/containers\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)\/attach(\?.*)?$/, async (ctx, match) => {
    const containerId = match[1];
    if (!(await containerBelongsToSession(ctx.socketPath, containerId, ctx.session.sessionId))) {
      forbidden(ctx.res, "Container does not belong to this session"); return;
    }
    pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  // POST /containers/{id}/exec — create exec instance
  route("POST", /^(?:\/v[\d.]+)?\/containers\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)\/exec(\?.*)?$/, async (ctx, match) => {
    const containerId = match[1];
    if (!(await containerBelongsToSession(ctx.socketPath, containerId, ctx.session.sessionId))) {
      forbidden(ctx.res, "Container does not belong to this session"); return;
    }
    pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  // POST /exec/{id}/start — streaming, resolve exec → parent container
  route("POST", /^(?:\/v[\d.]+)?\/exec\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)\/start(\?.*)?$/, async (ctx, match) => {
    const execId = match[1];
    const containerId = await getExecParentContainerId(ctx.socketPath, execId);
    if (!containerId || !(await containerBelongsToSession(ctx.socketPath, containerId, ctx.session.sessionId))) {
      forbidden(ctx.res, "Exec instance does not belong to this session"); return;
    }
    pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  // GET /exec/{id}/json — resolve exec → parent container
  route("GET", /^(?:\/v[\d.]+)?\/exec\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)\/json(\?.*)?$/, async (ctx, match) => {
    const execId = match[1];
    const containerId = await getExecParentContainerId(ctx.socketPath, execId);
    if (!containerId || !(await containerBelongsToSession(ctx.socketPath, containerId, ctx.session.sessionId))) {
      forbidden(ctx.res, "Exec instance does not belong to this session"); return;
    }
    pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  // POST /containers/{id}/rename — explicitly unsupported
  route("POST", /^(?:\/v[\d.]+)?\/containers\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)\/rename(\?.*)?$/, async (ctx) => {
    forbidden(ctx.res, "Container rename is not supported through the Docker proxy");
  });

  // POST /containers/{id}/update — explicitly unsupported (live resource updates)
  route("POST", /^(?:\/v[\d.]+)?\/containers\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)\/update(\?.*)?$/, async (ctx) => {
    forbidden(ctx.res, "Container update is not supported through the Docker proxy");
  });

  // ---- Networks (label-scoped) ----

  // POST /networks/create — overwrite label
  route("POST", /^(?:\/v[\d.]+)?\/networks\/create(\?.*)?$/, async (ctx) => {
    try {
      const bodyBuf = await readBody(ctx.req, MAX_BODY_SIZE);
      const body = JSON.parse(bodyBuf.toString()) as Record<string, unknown>;

      const labels = (body.Labels ?? {}) as Record<string, string>;
      labels[PARENT_SESSION_LABEL] = ctx.session.sessionId;
      body.Labels = labels;

      const sanitizedBody = Buffer.from(JSON.stringify(body));
      const dockerResult = await forwardToDocker(
        ctx.socketPath,
        "POST",
        ctx.req.url!,
        { "content-type": "application/json" },
        sanitizedBody,
      );

      ctx.res.writeHead(dockerResult.statusCode, dockerResult.headers);
      ctx.res.end(dockerResult.body);
    } catch (err) {
      badRequest(ctx.res, (err as Error).message);
    }
  });

  // GET /networks — filter to session-labeled networks
  route("GET", /^(?:\/v[\d.]+)?\/networks(\?.*)?$/, async (ctx) => {
    const dockerResult = await forwardToDocker(ctx.socketPath, "GET", ctx.req.url!, ctx.req.headers as Record<string, string>);
    if (dockerResult.statusCode !== 200) {
      ctx.res.writeHead(dockerResult.statusCode, dockerResult.headers);
      ctx.res.end(dockerResult.body);
      return;
    }

    const networks = JSON.parse(dockerResult.body.toString()) as Record<string, unknown>[];
    const filtered = networks.filter((n) => {
      const labels = n.Labels as Record<string, string> | undefined;
      return labels?.[PARENT_SESSION_LABEL] === ctx.session.sessionId;
    });

    respond(ctx.res, 200, filtered);
  });

  // GET /networks/{id} — label check
  route("GET", /^(?:\/v[\d.]+)?\/networks\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)(\?.*)?$/, async (ctx, match) => {
    const networkId = match[1];
    if (networkId === "create") { forbidden(ctx.res, "Endpoint not allowed: GET /networks/create"); return; }
    if (!(await networkBelongsToSession(ctx.socketPath, networkId, ctx.session.sessionId))) {
      forbidden(ctx.res, "Network does not belong to this session"); return;
    }
    pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  // DELETE /networks/{id} — label check
  route("DELETE", /^(?:\/v[\d.]+)?\/networks\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)(\?.*)?$/, async (ctx, match) => {
    const networkId = match[1];
    if (!(await networkBelongsToSession(ctx.socketPath, networkId, ctx.session.sessionId))) {
      forbidden(ctx.res, "Network does not belong to this session"); return;
    }
    pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  // POST /networks/{id}/connect — dual label check
  route("POST", /^(?:\/v[\d.]+)?\/networks\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)\/connect(\?.*)?$/, async (ctx, match) => {
    const networkId = match[1];
    if (!(await networkBelongsToSession(ctx.socketPath, networkId, ctx.session.sessionId))) {
      forbidden(ctx.res, "Network does not belong to this session"); return;
    }

    try {
      const bodyBuf = await readBody(ctx.req, MAX_BODY_SIZE);
      const body = JSON.parse(bodyBuf.toString()) as Record<string, unknown>;
      const containerId = body.Container as string;
      if (containerId && !(await containerBelongsToSession(ctx.socketPath, containerId, ctx.session.sessionId))) {
        forbidden(ctx.res, "Container does not belong to this session"); return;
      }

      const dockerResult = await forwardToDocker(
        ctx.socketPath,
        "POST",
        ctx.req.url!,
        { "content-type": "application/json" },
        bodyBuf,
      );

      ctx.res.writeHead(dockerResult.statusCode, dockerResult.headers);
      ctx.res.end(dockerResult.body);
    } catch (err) {
      badRequest(ctx.res, (err as Error).message);
    }
  });

  // POST /networks/{id}/disconnect — dual label check
  route("POST", /^(?:\/v[\d.]+)?\/networks\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)\/disconnect(\?.*)?$/, async (ctx, match) => {
    const networkId = match[1];
    if (!(await networkBelongsToSession(ctx.socketPath, networkId, ctx.session.sessionId))) {
      forbidden(ctx.res, "Network does not belong to this session"); return;
    }

    try {
      const bodyBuf = await readBody(ctx.req, MAX_BODY_SIZE);
      const body = JSON.parse(bodyBuf.toString()) as Record<string, unknown>;
      const containerId = body.Container as string;
      if (containerId && !(await containerBelongsToSession(ctx.socketPath, containerId, ctx.session.sessionId))) {
        forbidden(ctx.res, "Container does not belong to this session"); return;
      }

      const dockerResult = await forwardToDocker(
        ctx.socketPath,
        "POST",
        ctx.req.url!,
        { "content-type": "application/json" },
        bodyBuf,
      );

      ctx.res.writeHead(dockerResult.statusCode, dockerResult.headers);
      ctx.res.end(dockerResult.body);
    } catch (err) {
      badRequest(ctx.res, (err as Error).message);
    }
  });

  // ---- Volumes (label-scoped) ----

  // POST /volumes/create — overwrite label
  route("POST", /^(?:\/v[\d.]+)?\/volumes\/create(\?.*)?$/, async (ctx) => {
    try {
      const bodyBuf = await readBody(ctx.req, MAX_BODY_SIZE);
      const body = JSON.parse(bodyBuf.toString()) as Record<string, unknown>;

      // Block DriverOpts to prevent host-path escape via local driver bind mounts.
      // Without this, a session could create a volume backed by an arbitrary host
      // directory (e.g., DriverOpts: { type: "none", o: "bind", device: "/etc" })
      // which would then pass label-based volume ownership checks.
      const driverOpts = body.DriverOpts as Record<string, string> | undefined;
      if (driverOpts && Object.keys(driverOpts).length > 0) {
        forbidden(ctx.res, "Volume DriverOpts are not allowed (host-path escape risk)"); return;
      }

      // Only allow default local driver
      if (body.Driver && body.Driver !== "local") {
        forbidden(ctx.res, `Volume driver "${body.Driver as string}" is not allowed`); return;
      }

      const labels = (body.Labels ?? {}) as Record<string, string>;
      labels[PARENT_SESSION_LABEL] = ctx.session.sessionId;
      body.Labels = labels;

      const sanitizedBody = Buffer.from(JSON.stringify(body));
      const dockerResult = await forwardToDocker(
        ctx.socketPath,
        "POST",
        ctx.req.url!,
        { "content-type": "application/json" },
        sanitizedBody,
      );

      ctx.res.writeHead(dockerResult.statusCode, dockerResult.headers);
      ctx.res.end(dockerResult.body);
    } catch (err) {
      badRequest(ctx.res, (err as Error).message);
    }
  });

  // GET /volumes — filter to session-labeled volumes
  route("GET", /^(?:\/v[\d.]+)?\/volumes(\?.*)?$/, async (ctx) => {
    const dockerResult = await forwardToDocker(ctx.socketPath, "GET", ctx.req.url!, ctx.req.headers as Record<string, string>);
    if (dockerResult.statusCode !== 200) {
      ctx.res.writeHead(dockerResult.statusCode, dockerResult.headers);
      ctx.res.end(dockerResult.body);
      return;
    }

    const data = JSON.parse(dockerResult.body.toString()) as Record<string, unknown>;
    const volumes = (data.Volumes ?? []) as Record<string, unknown>[];
    const filtered = volumes.filter((v) => {
      const labels = v.Labels as Record<string, string> | undefined;
      return labels?.[PARENT_SESSION_LABEL] === ctx.session.sessionId;
    });
    data.Volumes = filtered;

    respond(ctx.res, 200, data);
  });

  // GET /volumes/{name} — label check
  route("GET", /^(?:\/v[\d.]+)?\/volumes\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)(\?.*)?$/, async (ctx, match) => {
    const volumeName = match[1];
    if (volumeName === "create") { forbidden(ctx.res, "Endpoint not allowed: GET /volumes/create"); return; }
    if (!(await volumeBelongsToSession(ctx.socketPath, volumeName, ctx.session.sessionId))) {
      forbidden(ctx.res, "Volume does not belong to this session"); return;
    }
    pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  // DELETE /volumes/{name} — label check
  route("DELETE", /^(?:\/v[\d.]+)?\/volumes\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)(\?.*)?$/, async (ctx, match) => {
    const volumeName = match[1];
    if (!(await volumeBelongsToSession(ctx.socketPath, volumeName, ctx.session.sessionId))) {
      forbidden(ctx.res, "Volume does not belong to this session"); return;
    }
    pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  // ---- Images (unscoped) ----

  route("GET", /^(?:\/v[\d.]+)?\/images\/.*$/, async (ctx) => {
    pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  // POST /images/create — image pull passthrough.
  // SECURITY NOTE: A session could pull very large images to exhaust host disk.
  // This is mitigated at the infrastructure level via Docker's --storage-opt and
  // disk quotas, not at the proxy layer. If disk pressure becomes an issue,
  // consider adding a pull rate limit or image size cap here.
  route("POST", /^(?:\/v[\d.]+)?\/images\/create(\?.*)?$/, async (ctx) => {
    pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  // DELETE /images/{id} — blocked to prevent cross-session image deletion.
  // Images are shared resources; allowing deletion could DoS other sessions.
  route("DELETE", /^(?:\/v[\d.]+)?\/images\/([^/]+)(\?.*)?$/, async (ctx) => {
    forbidden(ctx.res, "Image deletion is not allowed (images are shared resources)");
  });

  // POST /build — passthrough (chunked streaming, no body buffering).
  // SECURITY NOTE: The build context is a tar archive sent in the request body.
  // Docker builds operate on the sent context (not the host filesystem), so
  // COPY/ADD in the Dockerfile can only access files within that tar. However,
  // multi-stage builds with COPY --from=<image> can read from any image on the
  // host — this is a known Docker limitation, not a proxy-layer concern.
  // Resource limits on child containers (injected via sanitizeContainerCreate)
  // bound the impact of builds.
  route("POST", /^(?:\/v[\d.]+)?\/build(\?.*)?$/, async (ctx) => {
    pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  // ---- System (unscoped) ----

  route("GET", /^\/_ping$/, async (ctx) => {
    pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("GET", /^(?:\/v[\d.]+)?\/version$/, async (ctx) => {
    pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("GET", /^(?:\/v[\d.]+)?\/info$/, async (ctx) => {
    pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  // HEAD /_ping (Docker CLI sends HEAD first)
  route("HEAD", /^\/_ping$/, async (ctx) => {
    pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  return routes;
}

// ---------------------------------------------------------------------------
// Proxy server
// ---------------------------------------------------------------------------

/**
 * Create a Docker API proxy server.
 *
 * The proxy binds to the Docker bridge gateway IP (passed by the caller)
 * and forwards allowed Docker API requests to the host Docker daemon
 * via Unix socket, enforcing per-session policy.
 */
export function createDockerProxy(deps: DockerProxyDeps): http.Server {
  const socketPath = deps.socketPath ?? DOCKER_SOCKET;
  const routes = buildRoutes();

  const server = http.createServer(async (req, res) => {
    try {
      // Resolve source IP → session
      const remoteIp = req.socket.remoteAddress;
      if (!remoteIp) {
        forbidden(res, "Cannot determine source IP"); return;
      }

      // Strip IPv6 prefix (::ffff:) if present
      const ip = remoteIp.replace(/^::ffff:/, "");
      const session = deps.getSessionByContainerIp(ip);
      if (!session) {
        forbidden(res, "Unknown source IP"); return;
      }

      if (!session.dockerAccess) {
        forbidden(res, "Docker access not enabled for this session"); return;
      }

      const url = req.url ?? "/";
      const method = (req.method ?? "GET").toUpperCase();

      const ctx: RequestContext = { req, res, session, socketPath };

      // Find matching route
      for (const route of routes) {
        if (route.method !== method) continue;
        const match = url.match(route.pattern);
        if (match) {
          await route.handler(ctx, match);
          return;
        }
      }

      // Default deny
      forbidden(res, `Endpoint not allowed: ${method} ${url}`);
    } catch (err) {
      if (!res.headersSent) {
        respond(res, 500, { message: `Proxy error: ${(err as Error).message}` });
      }
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Bridge gateway IP resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the Docker bridge network gateway IP (e.g., 172.17.0.1).
 * This is the IP that session containers use to reach the orchestrator.
 */
export async function resolveBridgeGatewayIp(networkName = "bridge"): Promise<string> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      socketPath: DOCKER_SOCKET,
      path: `/networks/${networkName}`,
      method: "GET",
    };

    const req = http.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        try {
          const info = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
          const ipam = info.IPAM as Record<string, unknown> | undefined;
          const config = (ipam?.Config as Record<string, string>[] | undefined);
          const gateway = config?.[0]?.Gateway;
          if (!gateway) {
            reject(new Error(`No gateway IP found for Docker network "${networkName}"`));
            return;
          }
          resolve(gateway);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      res.on("error", reject);
    });

    req.on("error", reject);
    req.end();
  });
}
