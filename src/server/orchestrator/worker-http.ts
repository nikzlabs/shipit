/**
 * HTTP helpers for communicating with session worker containers.
 * Extracted from container-session-runner.ts for single-responsibility.
 */

import http from "node:http";

/**
 * Default timeout for worker HTTP calls. Every endpoint these helpers reach
 * (`/agent/start`, `/agent/stdin`, `/agent/interrupt`, `/agent/kill`,
 * `/terminal/*`, `/files/*`, `/secrets`, `/install`) returns immediately —
 * any actual long-running work streams back over SSE. So a 10s default
 * comfortably covers normal latency while still bounding a wedged worker
 * socket (the failure mode that previously made interrupt/kill hang
 * forever — see docs/124-session-rescue-and-diagnostics).
 *
 * Callers that genuinely need an unbounded request can pass `timeoutMs: 0`.
 */
export const DEFAULT_WORKER_TIMEOUT_MS = 10_000;

export interface WorkerHttpOpts {
  /**
   * Request timeout in milliseconds. When set, both connect and idle-read
   * are bounded; on timeout the request is aborted and the promise rejects
   * with a {@link WorkerTimeoutError}.
   *
   * Defaults to {@link DEFAULT_WORKER_TIMEOUT_MS}. Pass `0` to disable.
   * Use a short timeout (e.g. 3000ms) for health probes so a wedged worker
   * doesn't make the orchestrator hang on aggregation requests.
   */
  timeoutMs?: number;
}

/**
 * Thrown when a worker HTTP call exceeded its timeout. Distinguishable from
 * generic transport errors so callers can route it to a user-visible
 * "worker unreachable" message instead of a generic exception.
 */
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

function resolveTimeout(opts?: WorkerHttpOpts): number {
  // `undefined` → default; `0` → explicitly disabled; otherwise the value.
  if (opts?.timeoutMs === undefined) return DEFAULT_WORKER_TIMEOUT_MS;
  return Math.max(0, opts.timeoutMs);
}

export async function workerPost(baseUrl: string, path: string, body?: unknown, opts?: WorkerHttpOpts): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string | number> = {};
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
      (res) => {
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
      },
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

/** POST install commands to the session worker. Returns immediately; progress streams via SSE. */
export async function workerInstall(baseUrl: string, commands: string[]): Promise<unknown> {
  return workerPost(baseUrl, "/install", { commands });
}

/**
 * POST /agent/message on the session worker — inject a user message for live
 * steering (docs/140). Delegates to agent.sendUserMessage() inside the worker.
 */
export async function workerPostMessage(baseUrl: string, text: string, opts?: WorkerHttpOpts): Promise<void> {
  await workerPost(baseUrl, "/agent/message", { text }, opts);
}

/**
 * Send an HTTP PUT to a session worker endpoint. Mirrors {@link workerPost}
 * — JSON request/response, optional timeout, error-on-4xx-or-5xx semantics.
 */
export async function workerPut(baseUrl: string, path: string, body?: unknown, opts?: WorkerHttpOpts): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string | number> = {};
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
      (res) => {
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
      },
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

/**
 * PUT the full set of `agent: true` secrets to the session worker.
 * The worker replaces its tracked set on every call (not patch).
 */
export async function workerPushAgentSecrets(baseUrl: string, secrets: Record<string, string>): Promise<unknown> {
  return workerPut(baseUrl, "/secrets", { secrets });
}

export async function workerGet(baseUrl: string, path: string, opts?: WorkerHttpOpts): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);

    const timeoutMs = resolveTimeout(opts);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "GET",
        ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
      },
      (res) => {
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
      },
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
