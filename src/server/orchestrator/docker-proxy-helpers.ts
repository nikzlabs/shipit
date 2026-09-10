import http from "node:http";

export interface SessionInfo {
  sessionId: string;
  hostWorkspaceDir: string;
  dockerAccess: boolean;
  sessionNetworkName?: string;
  resourceLimits?: {
    /** Memory limit in bytes. */
    memory: number;
    /** CPU quota in microseconds per 100ms period. */
    cpuQuota: number;
    pidsLimit: number;
  };
}

export interface DockerProxyDeps {
  getSessionByContainerIp: (ip: string) => SessionInfo | undefined;
  /** Docker daemon socket path. Defaults to /var/run/docker.sock. */
  socketPath?: string;
  /** Suspend cached API trust checks across container starts; return the release callback. */
  onTopologyChange?: () => () => void;
}

export const PARENT_SESSION_LABEL = "shipit-parent-session";
export const MAX_BODY_SIZE = 10 * 1024 * 1024;
export const DOCKER_SOCKET = "/var/run/docker.sock";

export const CONTAINER_NAME_RE = "[a-zA-Z0-9][a-zA-Z0-9_.-]*";

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
  /** Open only after reading and authorizing a start request, to limit caller-controlled holds. */
  beginTopologyChange?: () => () => void;
}

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

export function pipeToDocker(
  socketPath: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  overridePath?: string,
): Promise<void> {
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

  res.on("close", () => {
    if (!dockerReq.destroyed) dockerReq.destroy();
  });

  req.pipe(dockerReq);

  // Await completion before releasing a topology hold.
  return new Promise<void>((resolve) => {
    res.on("close", resolve);
    res.on("finish", resolve);
    dockerReq.on("error", () => resolve());
  });
}
