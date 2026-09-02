/**
 * HTTP helpers for communicating with session worker containers.
 * Extracted from container-session-runner.ts for single-responsibility.
 */

import http from "node:http";
import { workerAuthHeaders } from "./worker-auth.js";

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

/**
 * The worker URL a {@link ContainerSessionRunner} carries between construction
 * and `setWorkerUrl()` — i.e. while its container is still being created.
 *
 * Exported so the runner and this module agree on the sentinel instead of
 * repeating the literal. Nothing may be dialed at this address: see
 * {@link WorkerUnavailableError}.
 */
export const PLACEHOLDER_WORKER_URL = "http://0.0.0.0:0";

/**
 * Thrown when a worker call is attempted against a session whose container
 * never came up — the runner still holds {@link PLACEHOLDER_WORKER_URL}.
 *
 * Without this guard the call is actually dialed, and Node reports
 * `connect ECONNREFUSED 0.0.0.0` (it omits the `:0`). That message reached
 * users as a chat error: it names neither the session container nor the real
 * failure, and it looks like a bug in the user's own project rather than a
 * container that failed to start. `dispose()` resolves the runner's
 * worker-ready gate so pending awaiters don't leak, which is what lets a
 * parked turn reach the POST with the placeholder still set — so this has to
 * be enforced at the transport, where no call site can forget it.
 *
 * The `reason` carries the actual container-creation failure when the runner
 * knows it (see `ContainerSessionRunner.markWorkerUnavailable`).
 */
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

/**
 * Reject rather than dial when the base URL is still the placeholder.
 *
 * Returns a rejected promise (not a synchronous throw) so the many
 * fire-and-forget `workerPost(...).catch(() => {})` call sites keep swallowing
 * it exactly as they swallow a transport error today.
 */
function guardPlaceholder(baseUrl: string, path: string): Promise<never> | null {
  if (baseUrl === PLACEHOLDER_WORKER_URL) {
    return Promise.reject(new WorkerUnavailableError(path));
  }
  return null;
}

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
  /**
   * planning#280 — abort an in-flight request from outside. Used by
   * `ContainerSessionRunner.dispose` to cancel a long-lived sub-agent spawn
   * whose container is about to be destroyed, so the awaiting caller learns the
   * run is over (and can land a terminal card) instead of hanging on a socket
   * nobody will ever answer. Rejects with {@link WorkerAbortedError}.
   */
  signal?: AbortSignal;
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

/**
 * planning#280 — thrown when a worker request was aborted via {@link WorkerHttpOpts.signal}.
 * Distinguishable from a timeout or a generic transport error so the caller can
 * report "cancelled" rather than "failed".
 */
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
  // `undefined` → default; `0` → explicitly disabled; otherwise the value.
  if (opts?.timeoutMs === undefined) return DEFAULT_WORKER_TIMEOUT_MS;
  return Math.max(0, opts.timeoutMs);
}

/**
 * Wire the standard JSON response handling onto a worker {@link http.IncomingMessage}:
 * buffer the body, parse it as JSON, reject on HTTP >= 400 (preferring the worker's
 * `.error` field over a generic `HTTP <status>`), reject with an "Invalid response
 * from worker" message when the body isn't JSON, otherwise resolve the parsed object.
 *
 * Shared by {@link workerPost}, {@link workerPut}, and {@link workerGet} — same
 * treatment as the already-extracted {@link resolveTimeout}.
 */
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
    // planning#313 — prove we're the orchestrator, not a peer session container.
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

/**
 * POST install commands to the session worker.
 *
 * The worker returns immediately: `{ skipped: true }` when the
 * `.shipit/.install-done` marker is already present, otherwise
 * `{ started: true }` while `agent.install` runs in the background and
 * progress/completion stream via SSE (`install_done` / `install_error`).
 */
export async function workerInstall(
  baseUrl: string,
  commands: string[],
  opts?: WorkerHttpOpts,
): Promise<unknown> {
  return workerPost(baseUrl, "/install", { commands }, opts);
}

/**
 * Ask the worker what {@link workerInstall} WOULD decide, without deciding it:
 * `{ skipped: true }` when the content-keyed marker still matches this
 * checkout, `{ skipped: false }` when the install would really run.
 *
 * Read-only on the worker — no marker is removed and nothing is started — so
 * the caller can probe before committing to anything the answer would make
 * pointless. Its one caller is the mid-session reinstall bracket, which must
 * not tear gated services down for a no-op (planning#2503).
 */
export async function workerInstallProbe(
  baseUrl: string,
  commands: string[],
  opts?: WorkerHttpOpts,
): Promise<unknown> {
  return workerPost(baseUrl, "/install/probe", { commands }, opts);
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
  const unavailable = guardPlaceholder(baseUrl, path);
  if (unavailable) return unavailable;
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    // planning#313 — see workerPost.
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

/**
 * PUT the full set of `agent: true` secrets to the session worker.
 * The worker replaces its tracked set on every call (not patch).
 */
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
        // planning#313 — see workerPost.
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
