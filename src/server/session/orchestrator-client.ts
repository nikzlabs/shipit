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
  const host = process.env.SHIPIT_HOST;
  const port = process.env.SHIPIT_PORT;
  if (!host || !port) return null;
  return `http://${host}:${port}`;
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
  private readonly baseUrl: string;
  private readonly sessionId: string;

  constructor(opts: OrchestratorClientOptions = {}) {
    const baseUrl = opts.baseUrl ?? resolveOrchestratorBaseUrl();
    const sessionId = opts.sessionId ?? resolveSessionId();
    if (!baseUrl) {
      throw new Error(
        "Orchestrator base URL is not configured (SHIPIT_HOST/SHIPIT_PORT env not set)",
      );
    }
    if (!sessionId) {
      throw new Error("Session ID is not configured (SESSION_ID env not set)");
    }
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.sessionId = sessionId;
  }

  /**
   * Build a session-scoped path. The session ID is always injected by the
   * worker — the agent cannot influence which session the request targets.
   */
  private url(suffix: string): string {
    const tail = suffix.startsWith("/") ? suffix : `/${suffix}`;
    return `${this.baseUrl}/api/sessions/${encodeURIComponent(this.sessionId)}${tail}`;
  }

  /** Send a JSON request to a session-scoped orchestrator endpoint. */
  async request(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    suffix: string,
    body?: unknown,
  ): Promise<OrchestratorResponse> {
    const url = this.url(suffix);
    const init: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (body !== undefined && method !== "GET") {
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      return { ok: false, status: 0, body: { error: getErrorMessage(err) } };
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = {};
    }
    return { ok: res.ok, status: res.status, body: parsed };
  }
}
