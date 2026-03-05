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
  /** Resource limits to enforce on child containers (from session config). */
  resourceLimits?: {
    /** Memory limit in bytes. */
    memory: number;
    /** CPU quota in microseconds per 100ms period. */
    cpuQuota: number;
    /** Maximum PIDs. */
    pidsLimit: number;
  };
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

// Docker container names: [a-zA-Z0-9][a-zA-Z0-9_.-]*
// Docker container IDs: [0-9a-f]{12,64}
// We use a single permissive pattern that covers both. The `/` separator in URL
// paths prevents path traversal, and `:` is excluded since it only appears in
// image references (handled by image routes with a separate pattern).
const CONTAINER_NAME_RE = "[a-zA-Z0-9][a-zA-Z0-9_.-]*";

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
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > maxSize) {
        rejected = true;
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!rejected) resolve(Buffer.concat(chunks)); });
    req.on("error", (err) => { if (!rejected) reject(err); });
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
    dockerRes.on("error", () => {
      res.destroy();
    });
    dockerRes.pipe(res);
  });

  dockerReq.on("error", (err) => {
    if (!res.headersSent) {
      respond(res, 502, { message: `Docker daemon error: ${err.message}` });
    }
  });

  // Abort upstream request if client disconnects
  res.on("close", () => {
    if (!dockerReq.destroyed) dockerReq.destroy();
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
    const info = JSON.parse(result.body.toString()) as Record<string, unknown>;
    return (info.Config as Record<string, unknown> | undefined)?.Labels !== undefined &&
      ((info.Config as Record<string, unknown>).Labels as Record<string, string>)?.[PARENT_SESSION_LABEL] === sessionId;
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
    const info = JSON.parse(result.body.toString()) as Record<string, unknown>;
    return (info.Labels as Record<string, string> | undefined)?.[PARENT_SESSION_LABEL] === sessionId;
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
    const info = JSON.parse(result.body.toString()) as Record<string, unknown>;
    return (info.Labels as Record<string, string> | undefined)?.[PARENT_SESSION_LABEL] === sessionId;
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
    const info = JSON.parse(result.body.toString()) as Record<string, unknown>;
    return info.ContainerID as string | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Validate that a host path (from Binds or Mounts) is under the session's workspace.
 * Uses realpath to resolve symlinks.
 *
 * SECURITY NOTE: There is an inherent TOCTOU (time-of-check-time-of-use) race here.
 * A process inside the session container could create a symlink pointing inside the
 * workspace to pass this check, then swap it to point outside before Docker mounts it.
 * This is a fundamental limitation of path validation from outside the mount namespace
 * and cannot be fully mitigated at this layer. The container's restricted capabilities
 * (CapDrop: ALL) and network isolation reduce the blast radius.
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

  // Reject privileged mode (check for any truthy value, not just boolean true,
  // to guard against type coercion with "true", 1, etc.)
  if (hostConfig.Privileged) {
    return { error: "Privileged mode is not allowed" };
  }

  // Reject CapAdd
  if (Array.isArray(hostConfig.CapAdd) && hostConfig.CapAdd.length > 0) {
    return { error: "Adding capabilities is not allowed" };
  }

  // Inject NET_RAW into CapDrop
  const capDrop = Array.isArray(hostConfig.CapDrop) ? [...hostConfig.CapDrop as string[]] : [];
  if (!capDrop.includes("NET_RAW")) {
    capDrop.push("NET_RAW");
  }
  hostConfig.CapDrop = capDrop;

  // Reject host and container NetworkMode (sharing another container's network namespace)
  const networkMode = hostConfig.NetworkMode as string | undefined;
  if (networkMode === "host" || (networkMode?.startsWith("container:"))) {
    return { error: "NetworkMode host/container is not allowed" };
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

  // Validate Mounts — only bind, volume, and tmpfs are allowed
  if (Array.isArray(hostConfig.Mounts)) {
    for (const mount of hostConfig.Mounts as Record<string, unknown>[]) {
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
      } else if (mount.Type === "tmpfs") {
        // tmpfs mounts are safe — no host path involved
      } else {
        return { error: `Mount type "${String(mount.Type)}" is not allowed (only bind, volume, tmpfs)` };
      }
    }
  }

  // Docker's Volumes field in create is just a set of mount points, not named volumes.
  // Named volumes referenced via Binds/Mounts are already validated above.

  // Reject VolumesFrom
  if (Array.isArray(hostConfig.VolumesFrom) && hostConfig.VolumesFrom.length > 0) {
    return { error: "VolumesFrom is not allowed" };
  }

  // Strip fields that could weaken container isolation
  delete hostConfig.SecurityOpt;
  delete hostConfig.CgroupParent;
  delete hostConfig.Sysctls;        // kernel parameter manipulation
  delete hostConfig.UsernsMode;     // user namespace sharing
  delete hostConfig.CgroupnsMode;   // cgroup namespace sharing
  delete hostConfig.Runtime;        // custom runtimes (e.g., nvidia) may grant elevated access
  delete hostConfig.ReadonlyPaths;  // removing default read-only paths weakens /proc isolation
  delete hostConfig.MaskedPaths;    // removing default masked paths exposes sensitive /proc entries
  delete hostConfig.GroupAdd;       // adding host groups (e.g., docker, disk) could escalate access

  // Overwrite shipit-parent-session label (never merge)
  const labels = (body.Labels ?? {}) as Record<string, string>;
  labels[PARENT_SESSION_LABEL] = session.sessionId;
  body.Labels = labels;

  // Enforce resource limits on child containers — capped at session's own limits.
  // Values <= 0 mean "unlimited" in Docker, so we always override them.
  if (session.resourceLimits) {
    const limits = session.resourceLimits;
    const currentMemory = hostConfig.Memory as number | undefined;
    if (!currentMemory || currentMemory <= 0 || currentMemory > limits.memory) {
      hostConfig.Memory = limits.memory;
    }
    const currentCpuQuota = hostConfig.CpuQuota as number | undefined;
    if (!currentCpuQuota || currentCpuQuota <= 0 || currentCpuQuota > limits.cpuQuota) {
      hostConfig.CpuQuota = limits.cpuQuota;
    }
    // Cap CpuPeriod to the standard 100ms to prevent effective CPU limit bypass
    // (inflating the period while quota is capped gives more CPU time)
    const currentPeriod = hostConfig.CpuPeriod as number | undefined;
    if (!currentPeriod || currentPeriod <= 0 || currentPeriod > 100_000) {
      hostConfig.CpuPeriod = 100_000;
    }
    const currentPids = hostConfig.PidsLimit as number | undefined;
    if (!currentPids || currentPids <= 0 || currentPids > limits.pidsLimit) {
      hostConfig.PidsLimit = limits.pidsLimit;
    }
  }

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
