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
import http from "node:http";
import https from "node:https";
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
   * `opts.timeoutMs` selects the transport (matching the `worker-http.ts`
   * convention where `0` means "unbounded"):
   * - omitted → plain `fetch` (the default for short PR/issue/source relays).
   * - positive (docs/182, the `shipit session wait` segment loop) → `fetch`
   *   with an AbortController so a black-holed (half-open) socket fails fast;
   *   a timed-out segment surfaces as `status: 0` (transient), which the shim
   *   swallows and retries rather than treating as a real outcome.
   * - `0` → an explicitly UNBOUNDED request (the `shipit agent run` spawn relay).
   *   Routed over Node's `http` rather than `fetch`: undici's default 300s
   *   `headersTimeout` would otherwise abort a multi-minute sub-agent consult —
   *   which the chain intends to run up to the 30-minute sub-agent cap — with an
   *   opaque "fetch failed", surfaced to the agent as an unreachable worker.
   *
   * Either transport preserves the multi-baseUrl fallback: a transport error on
   * one candidate is collected and the next is tried.
   */
  async request(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    suffix: string,
    body?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<OrchestratorResponse> {
    const payload = body !== undefined && method !== "GET" ? JSON.stringify(body) : undefined;
    const unbounded = opts?.timeoutMs === 0;
    const failures: string[] = [];
    for (const baseUrl of this.baseUrls) {
      const url = this.url(baseUrl, suffix);
      try {
        return unbounded
          ? await this.requestNodeHttp(method, url, payload)
          : await this.requestFetch(method, url, payload, opts?.timeoutMs);
      } catch (err) {
        failures.push(`${baseUrl}: ${getErrorMessage(err)}`);
        continue;
      }
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

  /**
   * `fetch`-based transport. Throws on a transport error (so {@link request}'s
   * fallback loop tries the next baseUrl); a non-2xx response or a body that
   * doesn't parse as JSON resolves normally with whatever status/body arrived.
   */
  private async requestFetch(
    method: string,
    url: string,
    payload: string | undefined,
    timeoutMs: number | undefined,
  ): Promise<OrchestratorResponse> {
    const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
    if (payload !== undefined) init.body = payload;
    const controller = timeoutMs ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    timer?.unref?.();
    try {
      const res = await fetch(url, { ...init, ...(controller ? { signal: controller.signal } : {}) });
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        parsed = {};
      }
      return { ok: res.ok, status: res.status, body: parsed };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Node-`http`/`https` transport with NO response timeout — see {@link request}
   * for why the unbounded spawn leg must avoid undici's default header timeout.
   * Throws on a transport error (caught by the fallback loop); any HTTP status
   * resolves normally.
   */
  private requestNodeHttp(
    method: string,
    url: string,
    payload: string | undefined,
  ): Promise<OrchestratorResponse> {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const mod = u.protocol === "https:" ? https : http;
      const headers: Record<string, string | number> = {};
      if (payload !== undefined) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(payload);
      }
      const req = mod.request(
        { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
        (res) => {
          let data = "";
          res.setEncoding("utf-8");
          res.on("data", (chunk: string) => { data += chunk; });
          res.on("end", () => {
            let parsed: unknown;
            try { parsed = JSON.parse(data); } catch { parsed = {}; }
            const status = res.statusCode ?? 0;
            resolve({ ok: status >= 200 && status < 300, status, body: parsed });
          });
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }
}
