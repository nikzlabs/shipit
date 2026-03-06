/**
 * HTTP utility functions and shared constants for the Docker API proxy.
 */

import http from "node:http";

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PARENT_SESSION_LABEL = "shipit-parent-session";
export const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB
export const DOCKER_SOCKET = "/var/run/docker.sock";

// Docker container names: [a-zA-Z0-9][a-zA-Z0-9_.-]*
// Docker container IDs: [0-9a-f]{12,64}
// We use a single permissive pattern that covers both. The `/` separator in URL
// paths prevents path traversal, and `:` is excluded since it only appears in
// image references (handled by image routes with a separate pattern).
export const CONTAINER_NAME_RE = "[a-zA-Z0-9][a-zA-Z0-9_.-]*";

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

export interface Route {
  method: string;
  pattern: RegExp;
  handler: (ctx: RequestContext, match: RegExpMatchArray) => Promise<void>;
}

export interface RequestContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  session: SessionInfo;
  socketPath: string;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

export function respond(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(json);
}

export function forbidden(res: http.ServerResponse, reason: string): void {
  respond(res, 403, { message: `Forbidden: ${reason}` });
}

export function badRequest(res: http.ServerResponse, reason: string): void {
  respond(res, 400, { message: `Bad request: ${reason}` });
}

// ---------------------------------------------------------------------------
// Body reading
// ---------------------------------------------------------------------------

export async function readBody(req: http.IncomingMessage, maxSize: number): Promise<Buffer> {
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

// ---------------------------------------------------------------------------
// Docker daemon forwarding
// ---------------------------------------------------------------------------

/**
 * Forward a request to the Docker daemon via Unix socket.
 * Returns the daemon's response body as a Buffer plus the status code.
 */
export async function forwardToDocker(
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
export function pipeToDocker(
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
