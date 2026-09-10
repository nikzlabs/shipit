import http from "node:http";
import https from "node:https";
import { getErrorMessage } from "../shared/utils.js";

export interface OrchestratorClientOptions {
  baseUrl?: string;
  sessionId?: string;
}

export interface OrchestratorResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

// Container recreation can invalidate SHIPIT_HOST; the Compose alias stays stable.
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

  // timeoutMs: 0 uses Node HTTP to avoid fetch's default 300s header timeout.
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
