import http from "node:http";
import { workerAuthHeaders } from "./worker-auth.js";

export const DEFAULT_WORKER_TIMEOUT_MS = 10_000;

// Until the container has an address; never dial this sentinel.
export const PLACEHOLDER_WORKER_URL = "http://0.0.0.0:0";

export class WorkerUnavailableError extends Error {
  readonly path: string;
  constructor(path: string, reason?: string) {
    super(
      reason
        ? `The session container isn't running, so the request could not be delivered: ${reason}`
        : "The session container isn't running, so the request could not be delivered. "
          + "It failed to start — send your message again to retry.",
    );
    this.name = "WorkerUnavailableError";
    this.path = path;
  }
}

function guardPlaceholder(baseUrl: string, path: string): Promise<never> | null {
  if (baseUrl === PLACEHOLDER_WORKER_URL) {
    return Promise.reject(new WorkerUnavailableError(path));
  }
  return null;
}

export interface WorkerHttpOpts {
  /** Socket timeout; defaults to 10 seconds. Zero disables it. */
  timeoutMs?: number;
  /** POST requests only; abort rejects with WorkerAbortedError. */
  signal?: AbortSignal;
}

export class WorkerTimeoutError extends Error {
  readonly path: string;
  readonly timeoutMs: number;
  constructor(path: string, timeoutMs: number) {
    super(`Worker request timed out after ${timeoutMs}ms: ${path}`);
    this.name = "WorkerTimeoutError";
    this.path = path;
    this.timeoutMs = timeoutMs;
  }
}

export class WorkerAbortedError extends Error {
  readonly path: string;
  readonly reason: string | undefined;
  constructor(path: string, reason?: string) {
    super(reason ? `Worker request aborted: ${path} (${reason})` : `Worker request aborted: ${path}`);
    this.name = "WorkerAbortedError";
    this.path = path;
    this.reason = reason;
  }
}

function resolveTimeout(opts?: WorkerHttpOpts): number {
  if (opts?.timeoutMs === undefined) return DEFAULT_WORKER_TIMEOUT_MS;
  return Math.max(0, opts.timeoutMs);
}

function attachWorkerResponseHandler(
  res: http.IncomingMessage,
  resolve: (value: unknown) => void,
  reject: (reason: Error) => void,
): void {
  let data = "";
  res.setEncoding("utf-8");
  res.on("data", (chunk: string) => { data += chunk; });
  res.on("end", () => {
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error((parsed.error as string) ?? `HTTP ${res.statusCode}`));
      } else {
        resolve(parsed);
      }
    } catch {
      reject(new Error(`Invalid response from worker: ${data}`));
    }
  });
  res.on("error", reject);
}

export async function workerPost(baseUrl: string, path: string, body?: unknown, opts?: WorkerHttpOpts): Promise<unknown> {
  const unavailable = guardPlaceholder(baseUrl, path);
  if (unavailable) return unavailable;
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string | number> = { ...workerAuthHeaders(baseUrl) };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }

    const timeoutMs = resolveTimeout(opts);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers,
        ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
      },
      (res) => attachWorkerResponseHandler(res, resolve, reject),
    );

    if (timeoutMs > 0) {
      req.on("timeout", () => {
        req.destroy(new WorkerTimeoutError(path, timeoutMs));
      });
    }

    const signal = opts?.signal;
    if (signal) {
      const abortReason = () =>
        typeof signal.reason === "string" ? signal.reason : undefined;
      if (signal.aborted) {
        req.destroy(new WorkerAbortedError(path, abortReason()));
      } else {
        const onAbort = () => req.destroy(new WorkerAbortedError(path, abortReason()));
        signal.addEventListener("abort", onAbort, { once: true });
        req.on("close", () => signal.removeEventListener("abort", onAbort));
      }
    }

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function workerInstall(
  baseUrl: string,
  commands: string[],
  opts?: WorkerHttpOpts,
): Promise<unknown> {
  return workerPost(baseUrl, "/install", { commands }, opts);
}

export async function workerPostMessage(baseUrl: string, text: string, opts?: WorkerHttpOpts): Promise<void> {
  await workerPost(baseUrl, "/agent/message", { text }, opts);
}

export async function workerPut(baseUrl: string, path: string, body?: unknown, opts?: WorkerHttpOpts): Promise<unknown> {
  const unavailable = guardPlaceholder(baseUrl, path);
  if (unavailable) return unavailable;
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string | number> = { ...workerAuthHeaders(baseUrl) };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }

    const timeoutMs = resolveTimeout(opts);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "PUT",
        headers,
        ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
      },
      (res) => attachWorkerResponseHandler(res, resolve, reject),
    );

    if (timeoutMs > 0) {
      req.on("timeout", () => {
        req.destroy(new WorkerTimeoutError(path, timeoutMs));
      });
    }

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Replace the worker's full agent-secret set. */
export async function workerPushAgentSecrets(baseUrl: string, secrets: Record<string, string>): Promise<unknown> {
  return workerPut(baseUrl, "/secrets", { secrets });
}

export async function workerGet(baseUrl: string, path: string, opts?: WorkerHttpOpts): Promise<unknown> {
  const unavailable = guardPlaceholder(baseUrl, path);
  if (unavailable) return unavailable;
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);

    const timeoutMs = resolveTimeout(opts);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "GET",
        headers: workerAuthHeaders(baseUrl),
        ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
      },
      (res) => attachWorkerResponseHandler(res, resolve, reject),
    );

    if (timeoutMs > 0) {
      req.on("timeout", () => {
        req.destroy(new WorkerTimeoutError(path, timeoutMs));
      });
    }

    req.on("error", reject);
    req.end();
  });
}
