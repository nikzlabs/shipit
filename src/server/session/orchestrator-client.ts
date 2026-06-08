/**
 * Tiny HTTP client used by the session worker's `/agent-ops/*` broker to call
 * the orchestrator's session-scoped routes.
 *
 * This is the only piece of code in the worker that knows how to talk to the
 * orchestrator over HTTP. The agent-ops router goes through it; the shim
 * never touches the orchestrator directly.
 *
 * Configuration (env vars set by the orchestrator at container creation):
 * - `SHIPIT_HOST` / `SHIPIT_PORT` — orchestrator address (set by
 *   `container-lifecycle.ts:buildEnv`).
 * - `SESSION_ID` — the session this container belongs to. The worker injects
 *   this into every request path so the agent cannot specify a different one.
 */
import { getErrorMessage } from "../shared/utils.js";

export interface OrchestratorClientOptions {
  /** Override the orchestrator base URL. Defaults to http://${SHIPIT_HOST}:${SHIPIT_PORT}. */
  baseUrl?: string;
  /** Override the session ID. Defaults to `process.env.SESSION_ID`. */
  sessionId?: string;
}

/** A response shape the worker uses internally — mirrors `fetch`'s status + json/text. */
export interface OrchestratorResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

/**
 * Resolves the orchestrator base URL from env. Returns `null` if unconfigured.
 * `SHIPIT_HOST`/`SHIPIT_PORT` are set by `container-lifecycle.ts:createContainer`.
 */
export function resolveOrchestratorBaseUrl(): string | null {
  return resolveOrchestratorBaseUrls()[0] ?? null;
}

/**
 * Resolves all candidate orchestrator URLs from env, ordered by preference.
 *
 * `SHIPIT_HOST` historically contained the orchestrator container hostname.
 * That hostname changes when the orchestrator container is recreated, while
 * long-lived session containers keep their original env. The stable Compose
 * service alias (`shipit`) continues to resolve to the current orchestrator on
 * the shared Docker network, so keep it as a fallback for worker->orchestrator
 * callbacks such as the review MCP bridge and gh shim.
 */
export function resolveOrchestratorBaseUrls(): string[] {
  const host = process.env.SHIPIT_HOST;
  const port = process.env.SHIPIT_PORT;
  if (!host || !port) return [];
  const hosts = [
    host,
    ...((process.env.SHIPIT_ORCHESTRATOR_FALLBACK_HOSTS ?? "shipit")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean)),
  ];
  const seen = new Set<string>();
  return hosts
    .filter((h) => {
      if (seen.has(h)) return false;
      seen.add(h);
      return true;
    })
    .map((h) => `http://${h}:${port}`);
}

/**
 * Resolves the session ID for this container from env. Returns `null` if unset.
 * `SESSION_ID` is set by `container-lifecycle.ts:buildEnv`.
 */
export function resolveSessionId(): string | null {
  return process.env.SESSION_ID ?? null;
}

/**
 * Tiny HTTP wrapper that scopes every call to the worker's session and the
 * configured orchestrator. Used by the agent-ops broker.
 */
export class OrchestratorClient {
  private readonly baseUrls: string[];
  private readonly sessionId: string;

  constructor(opts: OrchestratorClientOptions = {}) {
    const baseUrls = opts.baseUrl ? [opts.baseUrl] : resolveOrchestratorBaseUrls();
    const sessionId = opts.sessionId ?? resolveSessionId();
    if (baseUrls.length === 0) {
      throw new Error(
        "Orchestrator base URL is not configured (SHIPIT_HOST/SHIPIT_PORT env not set)",
      );
    }
    if (!sessionId) {
      throw new Error("Session ID is not configured (SESSION_ID env not set)");
    }
    this.baseUrls = baseUrls.map((url) => url.replace(/\/$/, ""));
    this.sessionId = sessionId;
  }

  /**
   * Build a session-scoped path. The session ID is always injected by the
   * worker — the agent cannot influence which session the request targets.
   */
  private url(baseUrl: string, suffix: string): string {
    const tail = suffix.startsWith("/") ? suffix : `/${suffix}`;
    return `${baseUrl}/api/sessions/${encodeURIComponent(this.sessionId)}${tail}`;
  }

  /**
   * Send a JSON request to a session-scoped orchestrator endpoint.
   *
   * docs/182 — `opts.timeoutMs` arms an AbortController so a black-holed
   * (half-open) socket fails fast instead of hanging until an OS-level timeout.
   * Used by the resilient `shipit session wait` segment loop, which bounds each
   * server segment: a timed-out segment surfaces as `status: 0` (transient),
   * which the shim swallows and retries rather than treating as a real outcome.
   * Other callers omit it and keep the unbounded behavior (spawn clones can run
   * for minutes).
   */
  async request(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    suffix: string,
    body?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<OrchestratorResponse> {
    const init: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (body !== undefined && method !== "GET") {
      init.body = JSON.stringify(body);
    }
    const failures: string[] = [];
    for (const baseUrl of this.baseUrls) {
      const url = this.url(baseUrl, suffix);
      const controller = opts?.timeoutMs ? new AbortController() : undefined;
      const timer = controller
        ? setTimeout(() => controller.abort(), opts!.timeoutMs)
        : undefined;
      timer?.unref?.();
      let res: Response;
      try {
        res = await fetch(url, { ...init, ...(controller ? { signal: controller.signal } : {}) });
      } catch (err) {
        failures.push(`${baseUrl}: ${getErrorMessage(err)}`);
        continue;
      } finally {
        if (timer) clearTimeout(timer);
      }
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        parsed = {};
      }
      return { ok: res.ok, status: res.status, body: parsed };
    }
    return {
      ok: false,
      status: 0,
      body: {
        error: failures.length > 0
          ? `Could not reach orchestrator (${failures.join("; ")})`
          : "Could not reach orchestrator",
      },
    };
  }
}
