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
import fs from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionInfo {
  sessionId: string;
  hostWorkspaceDir: string;
  dockerAccess: boolean;
  /** Session-specific bridge network name for child containers. */
  sessionNetworkName?: string;
}

export interface DockerProxyDeps {
  /** Resolve source IP → session info. */
  getSessionByContainerIp: (ip: string) => SessionInfo | undefined;
  /** Docker daemon socket path. Defaults to /var/run/docker.sock. */
  socketPath?: string;
}

export const PARENT_SESSION_LABEL = "shipit-parent-session";
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB
const DOCKER_SOCKET = "/var/run/docker.sock";

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

interface Route {
  method: string;
  pattern: RegExp;
  handler: (ctx: RequestContext, match: RegExpMatchArray) => Promise<void>;
}

interface RequestContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  session: SessionInfo;
  socketPath: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function respond(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(json);
}

function forbidden(res: http.ServerResponse, reason: string): void {
  respond(res, 403, { message: `Forbidden: ${reason}` });
}

function badRequest(res: http.ServerResponse, reason: string): void {
  respond(res, 400, { message: `Bad request: ${reason}` });
}

async function readBody(req: http.IncomingMessage, maxSize: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Forward a request to the Docker daemon via Unix socket.
 * Returns the daemon's response body as a Buffer plus the status code.
 */
async function forwardToDocker(
  socketPath: string,
  method: string,
  path: string,
  headers: Record<string, string | string[] | undefined>,
  body?: Buffer,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const reqHeaders: Record<string, string | string[] | undefined> = { ...headers };
    delete reqHeaders.host;
    delete reqHeaders.connection;

    if (body) {
      reqHeaders["content-length"] = String(body.length);
    }

    const opts: http.RequestOptions = {
      socketPath,
      path,
      method,
      headers: reqHeaders,
    };

    const dockerReq = http.request(opts, (dockerRes) => {
      const chunks: Buffer[] = [];
      dockerRes.on("data", (chunk: Buffer) => chunks.push(chunk));
      dockerRes.on("end", () => {
        resolve({
          statusCode: dockerRes.statusCode ?? 500,
          headers: dockerRes.headers,
          body: Buffer.concat(chunks),
        });
      });
      dockerRes.on("error", reject);
    });

    dockerReq.on("error", reject);
    if (body) dockerReq.write(body);
    dockerReq.end();
  });
}

/**
 * Pipe a request through to the Docker daemon (for streaming endpoints).
 * Copies the request and streams the response back to the client.
 */
function pipeToDocker(
  socketPath: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  overridePath?: string,
): void {
  const reqHeaders: Record<string, string | string[] | undefined> = { ...req.headers };
  delete reqHeaders.host;
  delete reqHeaders.connection;

  const opts: http.RequestOptions = {
    socketPath,
    path: overridePath ?? req.url,
    method: req.method,
    headers: reqHeaders,
  };

  const dockerReq = http.request(opts, (dockerRes) => {
    res.writeHead(dockerRes.statusCode ?? 500, dockerRes.headers);
    dockerRes.pipe(res);
  });

  dockerReq.on("error", (err) => {
    if (!res.headersSent) {
      respond(res, 502, { message: `Docker daemon error: ${err.message}` });
    }
  });

  req.pipe(dockerReq);
}

/**
 * Check if a container belongs to a session by inspecting its labels.
 */
async function containerBelongsToSession(
  socketPath: string,
  containerId: string,
  sessionId: string,
): Promise<boolean> {
  try {
    const result = await forwardToDocker(socketPath, "GET", `/containers/${containerId}/json`, {});
    if (result.statusCode !== 200) return false;
    const info = JSON.parse(result.body.toString());
    return info.Config?.Labels?.[PARENT_SESSION_LABEL] === sessionId;
  } catch {
    return false;
  }
}

/**
 * Check if a network belongs to a session by inspecting its labels.
 */
async function networkBelongsToSession(
  socketPath: string,
  networkId: string,
  sessionId: string,
): Promise<boolean> {
  try {
    const result = await forwardToDocker(socketPath, "GET", `/networks/${networkId}`, {});
    if (result.statusCode !== 200) return false;
    const info = JSON.parse(result.body.toString());
    return info.Labels?.[PARENT_SESSION_LABEL] === sessionId;
  } catch {
    return false;
  }
}

/**
 * Check if a volume belongs to a session by inspecting its labels.
 */
async function volumeBelongsToSession(
  socketPath: string,
  volumeName: string,
  sessionId: string,
): Promise<boolean> {
  try {
    const result = await forwardToDocker(socketPath, "GET", `/volumes/${volumeName}`, {});
    if (result.statusCode !== 200) return false;
    const info = JSON.parse(result.body.toString());
    return info.Labels?.[PARENT_SESSION_LABEL] === sessionId;
  } catch {
    return false;
  }
}

/**
 * Resolve an exec ID to its parent container ID by querying the Docker daemon.
 */
async function getExecParentContainerId(
  socketPath: string,
  execId: string,
): Promise<string | undefined> {
  try {
    const result = await forwardToDocker(socketPath, "GET", `/exec/${execId}/json`, {});
    if (result.statusCode !== 200) return undefined;
    const info = JSON.parse(result.body.toString());
    return info.ContainerID;
  } catch {
    return undefined;
  }
}

/**
 * Validate that a host path (from Binds or Mounts) is under the session's workspace.
 * Uses realpath to resolve symlinks.
 */
async function isPathUnderWorkspace(hostPath: string, workspaceDir: string): Promise<boolean> {
  try {
    const resolved = await fs.realpath(hostPath);
    const resolvedWorkspace = await fs.realpath(workspaceDir);
    return resolved.startsWith(resolvedWorkspace + path.sep) || resolved === resolvedWorkspace;
  } catch {
    // Path doesn't exist — reject
    return false;
  }
}

// ---------------------------------------------------------------------------
// Container create sanitization
// ---------------------------------------------------------------------------

async function sanitizeContainerCreate(
  body: Record<string, unknown>,
  session: SessionInfo,
  socketPath: string,
): Promise<{ error?: string }> {
  const hostConfig = (body.HostConfig ?? {}) as Record<string, unknown>;

  // Reject privileged mode
  if (hostConfig.Privileged === true) {
    return { error: "Privileged mode is not allowed" };
  }

  // Reject CapAdd
  if (Array.isArray(hostConfig.CapAdd) && hostConfig.CapAdd.length > 0) {
    return { error: "Adding capabilities is not allowed" };
  }

  // Inject NET_RAW into CapDrop
  const capDrop = Array.isArray(hostConfig.CapDrop) ? [...hostConfig.CapDrop] : [];
  if (!capDrop.includes("NET_RAW")) {
    capDrop.push("NET_RAW");
  }
  hostConfig.CapDrop = capDrop;

  // Reject host NetworkMode
  if (hostConfig.NetworkMode === "host") {
    return { error: "Host network mode is not allowed" };
  }

  // Reject host/container PidMode
  const pidMode = hostConfig.PidMode as string | undefined;
  if (pidMode && (pidMode === "host" || pidMode.startsWith("container:"))) {
    return { error: "PidMode host/container is not allowed" };
  }

  // Reject host/container IpcMode
  const ipcMode = hostConfig.IpcMode as string | undefined;
  if (ipcMode && (ipcMode === "host" || ipcMode.startsWith("container:"))) {
    return { error: "IpcMode host/container is not allowed" };
  }

  // Reject host UTSMode
  if (hostConfig.UTSMode === "host") {
    return { error: "UTSMode host is not allowed" };
  }

  // Reject Devices
  if (Array.isArray(hostConfig.Devices) && hostConfig.Devices.length > 0) {
    return { error: "Device mappings are not allowed" };
  }

  // Validate Binds
  if (Array.isArray(hostConfig.Binds)) {
    for (const bind of hostConfig.Binds as string[]) {
      // Format: host_path:container_path[:options]
      const hostPath = bind.split(":")[0];
      if (!(await isPathUnderWorkspace(hostPath, session.hostWorkspaceDir))) {
        return { error: `Bind mount path ${hostPath} is outside session workspace` };
      }
    }
  }

  // Validate Mounts
  if (Array.isArray(hostConfig.Mounts)) {
    for (const mount of hostConfig.Mounts as Array<Record<string, unknown>>) {
      if (mount.Type === "bind") {
        const source = mount.Source as string;
        if (!(await isPathUnderWorkspace(source, session.hostWorkspaceDir))) {
          return { error: `Bind mount source ${source} is outside session workspace` };
        }
      } else if (mount.Type === "volume") {
        const volumeName = mount.Source as string;
        if (volumeName && !(await volumeBelongsToSession(socketPath, volumeName, session.sessionId))) {
          return { error: `Volume ${volumeName} does not belong to this session` };
        }
      }
      // tmpfs mounts are allowed
    }
  }

  // Docker's Volumes field in create is just a set of mount points, not named volumes.
  // Named volumes referenced via Binds/Mounts are already validated above.

  // Reject VolumesFrom
  if (Array.isArray(hostConfig.VolumesFrom) && hostConfig.VolumesFrom.length > 0) {
    return { error: "VolumesFrom is not allowed" };
  }

  // Strip SecurityOpt
  delete hostConfig.SecurityOpt;

  // Strip CgroupParent
  delete hostConfig.CgroupParent;

  // Overwrite shipit-parent-session label (never merge)
  const labels = (body.Labels ?? {}) as Record<string, string>;
  labels[PARENT_SESSION_LABEL] = session.sessionId;
  body.Labels = labels;

  // Inject session-specific network so child containers can communicate
  if (session.sessionNetworkName) {
    // If NetworkMode is not explicitly set or is "default", use session network
    if (!hostConfig.NetworkMode || hostConfig.NetworkMode === "default" || hostConfig.NetworkMode === "bridge") {
      hostConfig.NetworkMode = session.sessionNetworkName;
    }
  }

  // Write back HostConfig
  body.HostConfig = hostConfig;

  return {};
}

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
        return forbidden(ctx.res, result.error);
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

    const containers = JSON.parse(dockerResult.body.toString()) as Array<Record<string, unknown>>;
    const filtered = containers.filter((c) => {
      const labels = c.Labels as Record<string, string> | undefined;
      return labels?.[PARENT_SESSION_LABEL] === ctx.session.sessionId;
    });

    respond(ctx.res, 200, filtered);
  });

  // Container operations that need label check
  const containerLabelOps: Array<{ method: string; suffix: string }> = [
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
      `^(?:\\/v[\\d.]+)?\\/containers\\/([a-zA-Z0-9_.-]+)${escapedSuffix}(\\?.*)?$`,
    );
    route(op.method, pattern, async (ctx, match) => {
      const containerId = match[1];
      if (!(await containerBelongsToSession(ctx.socketPath, containerId, ctx.session.sessionId))) {
        return forbidden(ctx.res, "Container does not belong to this session");
      }
      pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
    });
  }

  // ---- Container I/O (label-scoped, some streaming) ----

  // GET /containers/{id}/logs — streaming
  route("GET", /^(?:\/v[\d.]+)?\/containers\/([a-zA-Z0-9_.-]+)\/logs(\?.*)?$/, async (ctx, match) => {
    const containerId = match[1];
    if (!(await containerBelongsToSession(ctx.socketPath, containerId, ctx.session.sessionId))) {
      return forbidden(ctx.res, "Container does not belong to this session");
    }
    pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  // POST /containers/{id}/attach — streaming
  route("POST", /^(?:\/v[\d.]+)?\/containers\/([a-zA-Z0-9_.-]+)\/attach(\?.*)?$/, async (ctx, match) => {
    const containerId = match[1];
    if (!(await containerBelongsToSession(ctx.socketPath, containerId, ctx.session.sessionId))) {
      return forbidden(ctx.res, "Container does not belong to this session");
    }
    pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  // POST /containers/{id}/exec — create exec instance
  route("POST", /^(?:\/v[\d.]+)?\/containers\/([a-zA-Z0-9_.-]+)\/exec(\?.*)?$/, async (ctx, match) => {
    const containerId = match[1];
    if (!(await containerBelongsToSession(ctx.socketPath, containerId, ctx.session.sessionId))) {
      return forbidden(ctx.res, "Container does not belong to this session");
    }
    pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  // POST /exec/{id}/start — streaming, resolve exec → parent container
  route("POST", /^(?:\/v[\d.]+)?\/exec\/([a-zA-Z0-9_.-]+)\/start(\?.*)?$/, async (ctx, match) => {
    const execId = match[1];
    const containerId = await getExecParentContainerId(ctx.socketPath, execId);
    if (!containerId || !(await containerBelongsToSession(ctx.socketPath, containerId, ctx.session.sessionId))) {
      return forbidden(ctx.res, "Exec instance does not belong to this session");
    }
    pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  // GET /exec/{id}/json — resolve exec → parent container
  route("GET", /^(?:\/v[\d.]+)?\/exec\/([a-zA-Z0-9_.-]+)\/json(\?.*)?$/, async (ctx, match) => {
    const execId = match[1];
    const containerId = await getExecParentContainerId(ctx.socketPath, execId);
    if (!containerId || !(await containerBelongsToSession(ctx.socketPath, containerId, ctx.session.sessionId))) {
      return forbidden(ctx.res, "Exec instance does not belong to this session");
    }
    pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
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

    const networks = JSON.parse(dockerResult.body.toString()) as Array<Record<string, unknown>>;
    const filtered = networks.filter((n) => {
      const labels = n.Labels as Record<string, string> | undefined;
      return labels?.[PARENT_SESSION_LABEL] === ctx.session.sessionId;
    });

    respond(ctx.res, 200, filtered);
  });

  // GET /networks/{id} — label check
  route("GET", /^(?:\/v[\d.]+)?\/networks\/([a-zA-Z0-9_.-]+)(\?.*)?$/, async (ctx, match) => {
    const networkId = match[1];
    if (networkId === "create") return; // Skip, handled by POST /networks/create
    if (!(await networkBelongsToSession(ctx.socketPath, networkId, ctx.session.sessionId))) {
      return forbidden(ctx.res, "Network does not belong to this session");
    }
    pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  // DELETE /networks/{id} — label check
  route("DELETE", /^(?:\/v[\d.]+)?\/networks\/([a-zA-Z0-9_.-]+)(\?.*)?$/, async (ctx, match) => {
    const networkId = match[1];
    if (!(await networkBelongsToSession(ctx.socketPath, networkId, ctx.session.sessionId))) {
      return forbidden(ctx.res, "Network does not belong to this session");
    }
    pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  // POST /networks/{id}/connect — dual label check
  route("POST", /^(?:\/v[\d.]+)?\/networks\/([a-zA-Z0-9_.-]+)\/connect(\?.*)?$/, async (ctx, match) => {
    const networkId = match[1];
    if (!(await networkBelongsToSession(ctx.socketPath, networkId, ctx.session.sessionId))) {
      return forbidden(ctx.res, "Network does not belong to this session");
    }

    try {
      const bodyBuf = await readBody(ctx.req, MAX_BODY_SIZE);
      const body = JSON.parse(bodyBuf.toString()) as Record<string, unknown>;
      const containerId = body.Container as string;
      if (containerId && !(await containerBelongsToSession(ctx.socketPath, containerId, ctx.session.sessionId))) {
        return forbidden(ctx.res, "Container does not belong to this session");
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
  route("POST", /^(?:\/v[\d.]+)?\/networks\/([a-zA-Z0-9_.-]+)\/disconnect(\?.*)?$/, async (ctx, match) => {
    const networkId = match[1];
    if (!(await networkBelongsToSession(ctx.socketPath, networkId, ctx.session.sessionId))) {
      return forbidden(ctx.res, "Network does not belong to this session");
    }

    try {
      const bodyBuf = await readBody(ctx.req, MAX_BODY_SIZE);
      const body = JSON.parse(bodyBuf.toString()) as Record<string, unknown>;
      const containerId = body.Container as string;
      if (containerId && !(await containerBelongsToSession(ctx.socketPath, containerId, ctx.session.sessionId))) {
        return forbidden(ctx.res, "Container does not belong to this session");
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
    const volumes = (data.Volumes ?? []) as Array<Record<string, unknown>>;
    const filtered = volumes.filter((v) => {
      const labels = v.Labels as Record<string, string> | undefined;
      return labels?.[PARENT_SESSION_LABEL] === ctx.session.sessionId;
    });
    data.Volumes = filtered;

    respond(ctx.res, 200, data);
  });

  // GET /volumes/{name} — label check
  route("GET", /^(?:\/v[\d.]+)?\/volumes\/([a-zA-Z0-9_.-]+)(\?.*)?$/, async (ctx, match) => {
    const volumeName = match[1];
    if (volumeName === "create") return; // Skip, handled by POST /volumes/create
    if (!(await volumeBelongsToSession(ctx.socketPath, volumeName, ctx.session.sessionId))) {
      return forbidden(ctx.res, "Volume does not belong to this session");
    }
    pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  // DELETE /volumes/{name} — label check
  route("DELETE", /^(?:\/v[\d.]+)?\/volumes\/([a-zA-Z0-9_.-]+)(\?.*)?$/, async (ctx, match) => {
    const volumeName = match[1];
    if (!(await volumeBelongsToSession(ctx.socketPath, volumeName, ctx.session.sessionId))) {
      return forbidden(ctx.res, "Volume does not belong to this session");
    }
    pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  // ---- Images (unscoped) ----

  route("GET", /^(?:\/v[\d.]+)?\/images\/.*$/, async (ctx) => {
    pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("POST", /^(?:\/v[\d.]+)?\/images\/create(\?.*)?$/, async (ctx) => {
    pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  route("DELETE", /^(?:\/v[\d.]+)?\/images\/([^/]+)(\?.*)?$/, async (ctx) => {
    pipeToDocker(ctx.socketPath, ctx.req, ctx.res);
  });

  // POST /build — passthrough (chunked streaming, no body buffering)
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
        return forbidden(res, "Cannot determine source IP");
      }

      // Strip IPv6 prefix (::ffff:) if present
      const ip = remoteIp.replace(/^::ffff:/, "");
      const session = deps.getSessionByContainerIp(ip);
      if (!session) {
        return forbidden(res, "Unknown source IP");
      }

      if (!session.dockerAccess) {
        return forbidden(res, "Docker access not enabled for this session");
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
export async function resolveBridgeGatewayIp(networkName: string = "bridge"): Promise<string> {
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
          const info = JSON.parse(Buffer.concat(chunks).toString());
          const gateway = info.IPAM?.Config?.[0]?.Gateway;
          if (!gateway) {
            reject(new Error(`No gateway IP found for Docker network "${networkName}"`));
            return;
          }
          resolve(gateway);
        } catch (err) {
          reject(err);
        }
      });
      res.on("error", reject);
    });

    req.on("error", reject);
    req.end();
  });
}
