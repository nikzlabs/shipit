import http from "node:http";
import https from "node:https";
import { getErrorMessage } from "../shared/utils.js";
import { orchestratorFallbackHosts } from "../shared/orchestrator-hosts.js";

export interface OrchestratorClientOptions {
  baseUrl?: string;
  sessionId?: string;
}

export interface OrchestratorResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

// For each attempt. The numbers are those of fetch, the transport before this one.
const CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 300_000;

class AttemptFailed extends Error {
  constructor(message: string, readonly connected: boolean) {
    super(message);
  }
}

// Container recreation can invalidate SHIPIT_HOST; the Compose alias stays stable.
export function resolveOrchestratorBaseUrls(): string[] {
  const host = process.env.SHIPIT_HOST;
  const port = process.env.SHIPIT_PORT;
  if (!host || !port) return [];
  const hosts = [host, ...orchestratorFallbackHosts()];
  return [...new Set(hosts)].map((h) => `http://${h}:${port}`);
}

export function resolveSessionId(): string | null {
  return process.env.SESSION_ID ?? null;
}

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

  // Scope requests with the worker's session ID, never an ID supplied by the agent.
  private url(baseUrl: string, suffix: string): string {
    const tail = suffix.startsWith("/") ? suffix : `/${suffix}`;
    return `${baseUrl}/api/sessions/${encodeURIComponent(this.sessionId)}${tail}`;
  }

  // timeoutMs: 0 is no limit. A request that is not a read goes to the next host only
  // while it cannot have arrived (docs/306-spawn-retry-safety req 6).
  async request(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    suffix: string,
    body?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<OrchestratorResponse> {
    const payload = body !== undefined && method !== "GET" ? JSON.stringify(body) : undefined;
    const limitMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const failures: string[] = [];
    for (const baseUrl of this.baseUrls) {
      try {
        return await this.send(method, this.url(baseUrl, suffix), payload, limitMs);
      } catch (err) {
        failures.push(`${baseUrl}: ${getErrorMessage(err)}`);
        if (method !== "GET" && err instanceof AttemptFailed && err.connected) {
          return {
            ok: false,
            status: 0,
            body: {
              error: `The connection to the orchestrator failed after the request was sent (${failures.join("; ")}). `
                + "The request was not sent again, because the orchestrator may have carried it out.",
            },
          };
        }
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

  private send(
    method: string,
    url: string,
    payload: string | undefined,
    limitMs: number,
  ): Promise<OrchestratorResponse> {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const mod = u.protocol === "https:" ? https : http;
      const headers: Record<string, string | number> = {};
      if (payload !== undefined) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(payload);
      }
      let connected = false;
      const req = mod.request(
        u,
        // agent: false gives the call a socket of its own. A pooled socket is already
        // connected, so a failure on it could be before or after the request arrived.
        { method, headers, agent: false },
        (res) => {
          let data = "";
          res.setEncoding("utf-8");
          res.on("data", (chunk: string) => { data += chunk; });
          res.on("end", () => {
            clearTimeout(limitTimer);
            let parsed: unknown;
            try { parsed = JSON.parse(data); } catch { parsed = {}; }
            const status = res.statusCode ?? 0;
            resolve({ ok: status >= 200 && status < 300, status, body: parsed });
          });
          res.on("error", fail);
        },
      );
      const connectTimer = setTimeout(() => giveUp(`no connection after ${CONNECT_TIMEOUT_MS} ms`), CONNECT_TIMEOUT_MS);
      const limitTimer = limitMs > 0
        ? setTimeout(() => giveUp(`no answer after ${limitMs} ms`), limitMs)
        : undefined;
      function fail(err: unknown): void {
        clearTimeout(connectTimer);
        clearTimeout(limitTimer);
        reject(new AttemptFailed(getErrorMessage(err), connected));
      }
      function giveUp(why: string): void {
        fail(new Error(why));
        req.destroy();
      }
      req.on("socket", (socket) => {
        socket.once("connect", () => {
          connected = true;
          clearTimeout(connectTimer);
        });
      });
      req.on("error", fail);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }
}
