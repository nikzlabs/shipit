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
import { sanitizeBuildRequest, sanitizeContainerCreate } from "./docker-proxy-sanitize.js";

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
export { sanitizeBuildRequest, sanitizeContainerCreate } from "./docker-proxy-sanitize.js";

function buildRoutes(): Route[] {
  const routes: Route[] = [];

  function route(method: string, pattern: RegExp, handler: Route["handler"]): void {
    routes.push({ method, pattern, handler });
  }

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

  route("GET", /^\/v[\d.]+\/containers\/json(\?.*)?$|^\/containers\/json(\?.*)?$/, async (ctx) => {
    const dockerResult = await forwardToDocker(ctx.socketPath, "GET", ctx.req.url!, ctx.req.headers);
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

  // Hold API trust refresh across starts. Creates have no IP; removals leave safe stale denials.
  const containerLabelOps: { method: string; suffix: string; topologyChanging?: boolean }[] = [
    { method: "GET", suffix: "/json" },
    { method: "POST", suffix: "/start", topologyChanging: true },
    { method: "POST", suffix: "/stop" },
    { method: "POST", suffix: "/restart", topologyChanging: true },
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
      const endTopologyChange = op.topologyChanging ? ctx.beginTopologyChange?.() : undefined;
      try {
        const piped = pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
        if (op.topologyChanging) await piped;
      } finally {
        endTopologyChange?.();
      }
    });
  }

  route("GET", /^(?:\/v[\d.]+)?\/containers\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)\/logs(\?.*)?$/, async (ctx, match) => {
    const containerId = match[1];
    if (!(await containerBelongsToSession(ctx.socketPath, containerId, ctx.session.sessionId))) {
      forbidden(ctx.res, "Container does not belong to this session"); return;
    }
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("POST", /^(?:\/v[\d.]+)?\/containers\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)\/attach(\?.*)?$/, async (ctx, match) => {
    const containerId = match[1];
    if (!(await containerBelongsToSession(ctx.socketPath, containerId, ctx.session.sessionId))) {
      forbidden(ctx.res, "Container does not belong to this session"); return;
    }
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("POST", /^(?:\/v[\d.]+)?\/containers\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)\/exec(\?.*)?$/, async (ctx, match) => {
    const containerId = match[1];
    if (!(await containerBelongsToSession(ctx.socketPath, containerId, ctx.session.sessionId))) {
      forbidden(ctx.res, "Container does not belong to this session"); return;
    }
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("POST", /^(?:\/v[\d.]+)?\/exec\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)\/start(\?.*)?$/, async (ctx, match) => {
    const execId = match[1];
    const containerId = await getExecParentContainerId(ctx.socketPath, execId);
    if (!containerId || !(await containerBelongsToSession(ctx.socketPath, containerId, ctx.session.sessionId))) {
      forbidden(ctx.res, "Exec instance does not belong to this session"); return;
    }
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("GET", /^(?:\/v[\d.]+)?\/exec\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)\/json(\?.*)?$/, async (ctx, match) => {
    const execId = match[1];
    const containerId = await getExecParentContainerId(ctx.socketPath, execId);
    if (!containerId || !(await containerBelongsToSession(ctx.socketPath, containerId, ctx.session.sessionId))) {
      forbidden(ctx.res, "Exec instance does not belong to this session"); return;
    }
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("POST", /^(?:\/v[\d.]+)?\/containers\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)\/rename(\?.*)?$/, async (ctx) => {
    forbidden(ctx.res, "Container rename is not supported through the Docker proxy");
  });

  route("POST", /^(?:\/v[\d.]+)?\/containers\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)\/update(\?.*)?$/, async (ctx) => {
    forbidden(ctx.res, "Container update is not supported through the Docker proxy");
  });

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

  route("GET", /^(?:\/v[\d.]+)?\/networks(\?.*)?$/, async (ctx) => {
    const dockerResult = await forwardToDocker(ctx.socketPath, "GET", ctx.req.url!, ctx.req.headers);
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

  route("GET", /^(?:\/v[\d.]+)?\/networks\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)(\?.*)?$/, async (ctx, match) => {
    const networkId = match[1];
    if (networkId === "create") { forbidden(ctx.res, "Endpoint not allowed: GET /networks/create"); return; }
    if (!(await networkBelongsToSession(ctx.socketPath, networkId, ctx.session.sessionId))) {
      forbidden(ctx.res, "Network does not belong to this session"); return;
    }
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("DELETE", /^(?:\/v[\d.]+)?\/networks\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)(\?.*)?$/, async (ctx, match) => {
    const networkId = match[1];
    if (!(await networkBelongsToSession(ctx.socketPath, networkId, ctx.session.sessionId))) {
      forbidden(ctx.res, "Network does not belong to this session"); return;
    }
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

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

      // A network attachment adds an address to the API trust index.
      const endTopologyChange = ctx.beginTopologyChange?.();
      let dockerResult;
      try {
        dockerResult = await forwardToDocker(
          ctx.socketPath,
          "POST",
          ctx.req.url!,
          { "content-type": "application/json" },
          bodyBuf,
        );
      } finally {
        endTopologyChange?.();
      }

      ctx.res.writeHead(dockerResult.statusCode, dockerResult.headers);
      ctx.res.end(dockerResult.body);
    } catch (err) {
      badRequest(ctx.res, (err as Error).message);
    }
  });

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

  route("POST", /^(?:\/v[\d.]+)?\/volumes\/create(\?.*)?$/, async (ctx) => {
    try {
      const bodyBuf = await readBody(ctx.req, MAX_BODY_SIZE);
      const body = JSON.parse(bodyBuf.toString()) as Record<string, unknown>;

      // DriverOpts can bind arbitrary host paths into an otherwise session-owned volume.
      const driverOpts = body.DriverOpts as Record<string, string> | undefined;
      if (driverOpts && Object.keys(driverOpts).length > 0) {
        forbidden(ctx.res, "Volume DriverOpts are not allowed (host-path escape risk)"); return;
      }

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

  route("GET", /^(?:\/v[\d.]+)?\/volumes(\?.*)?$/, async (ctx) => {
    const dockerResult = await forwardToDocker(ctx.socketPath, "GET", ctx.req.url!, ctx.req.headers);
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

  route("GET", /^(?:\/v[\d.]+)?\/volumes\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)(\?.*)?$/, async (ctx, match) => {
    const volumeName = match[1];
    if (volumeName === "create") { forbidden(ctx.res, "Endpoint not allowed: GET /volumes/create"); return; }
    if (!(await volumeBelongsToSession(ctx.socketPath, volumeName, ctx.session.sessionId))) {
      forbidden(ctx.res, "Volume does not belong to this session"); return;
    }
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("DELETE", /^(?:\/v[\d.]+)?\/volumes\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)(\?.*)?$/, async (ctx, match) => {
    const volumeName = match[1];
    if (!(await volumeBelongsToSession(ctx.socketPath, volumeName, ctx.session.sessionId))) {
      forbidden(ctx.res, "Volume does not belong to this session"); return;
    }
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("GET", /^(?:\/v[\d.]+)?\/images\/.*$/, async (ctx) => {
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("POST", /^(?:\/v[\d.]+)?\/images\/create(\?.*)?$/, async (ctx) => {
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("DELETE", /^(?:\/v[\d.]+)?\/images\/([^/]+)(\?.*)?$/, async (ctx) => {
    forbidden(ctx.res, "Image deletion is not allowed (images are shared resources)");
  });

  route("POST", /^(?:\/v[\d.]+)?\/build(\?.*)?$/, async (ctx) => {
    const result = await sanitizeBuildRequest(
      ctx.req.url ?? "",
      ctx.req.headers["content-type"],
      ctx.session,
      ctx.socketPath,
    );
    if (result.error) {
      forbidden(ctx.res, result.error); return;
    }
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("GET", /^\/_ping$/, async (ctx) => {
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("GET", /^(?:\/v[\d.]+)?\/version$/, async (ctx) => {
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("GET", /^(?:\/v[\d.]+)?\/info$/, async (ctx) => {
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("HEAD", /^\/_ping$/, async (ctx) => {
    void pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  return routes;
}

export function createDockerProxy(deps: DockerProxyDeps): http.Server {
  const socketPath = deps.socketPath ?? DOCKER_SOCKET;
  const routes = buildRoutes();

  const server = http.createServer(async (req, res) => {
    try {
      const remoteIp = req.socket.remoteAddress;
      if (!remoteIp) {
        forbidden(res, "Cannot determine source IP"); return;
      }

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

      const ctx: RequestContext = {
        req, res, session, socketPath,
        ...(deps.onTopologyChange ? { beginTopologyChange: deps.onTopologyChange } : {}),
      };

      for (const route of routes) {
        if (route.method !== method) continue;
        const match = url.match(route.pattern);
        if (match) {
          await route.handler(ctx, match);
          return;
        }
      }

      forbidden(res, `Endpoint not allowed: ${method} ${url}`);
    } catch (err) {
      if (!res.headersSent) {
        respond(res, 500, { message: `Proxy error: ${(err as Error).message}` });
      }
    }
  });

  return server;
}

export async function resolveOwnContainerIp(networkName = "bridge"): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const containerId = (await readFile("/etc/hostname", "utf-8")).trim();

  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: DOCKER_SOCKET, path: `/containers/${containerId}/json`, method: "GET" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const info = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
            const networkSettings = info.NetworkSettings as Record<string, unknown> | undefined;
            const networks = networkSettings?.Networks as Record<string, Record<string, unknown>> | undefined;
            const net = networks?.[networkName];
            const ip = net?.IPAddress as string | undefined;
            if (!ip) {
              reject(new Error(`Container ${containerId} has no IP on network "${networkName}"`));
              return;
            }
            resolve(ip);
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
        res.on("error", reject);
      },
    );

    req.on("error", reject);
    req.end();
  });
}
