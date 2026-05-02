/**
 * HTTP helpers for communicating with session worker containers.
 * Extracted from container-session-runner.ts for single-responsibility.
 */

import http from "node:http";

export interface WorkerHttpOpts {
  /**
   * Request timeout in milliseconds. When set, both connect and idle-read
   * are bounded; on timeout the request is aborted and the promise rejects
   * with `Error("worker request timed out")`. Default: no timeout (Node's
   * built-in socket idle timeout applies).
   *
   * Use a short timeout (e.g. 3000ms) for health probes so a wedged worker
   * doesn't make the orchestrator hang on aggregation requests.
   */
  timeoutMs?: number;
}

function newTimeoutError(): Error {
  return new Error("worker request timed out");
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

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers,
        ...(opts?.timeoutMs ? { timeout: opts.timeoutMs } : {}),
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

    if (opts?.timeoutMs) {
      req.on("timeout", () => {
        req.destroy(newTimeoutError());
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

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "PUT",
        headers,
        ...(opts?.timeoutMs ? { timeout: opts.timeoutMs } : {}),
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

    if (opts?.timeoutMs) {
      req.on("timeout", () => {
        req.destroy(newTimeoutError());
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

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "GET",
        ...(opts?.timeoutMs ? { timeout: opts.timeoutMs } : {}),
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

    if (opts?.timeoutMs) {
      req.on("timeout", () => {
        req.destroy(newTimeoutError());
      });
    }

    req.on("error", reject);
    req.end();
  });
}
