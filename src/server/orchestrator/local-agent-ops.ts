// Each loopback listener binds requests to one session. Local mode shares the orchestrator's OS user.
import http from "node:http";
import https from "node:https";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { getErrorMessage } from "../shared/utils.js";

const EXACT_ROUTES: Readonly<Record<string, string>> = {
  "pr/create": "pr/agent-create",
  "pr/view": "pr/view",
  "pr/list": "pr/list",
  "pr/status": "pr/status",
  "run/list": "actions/runs",
  "run/view": "actions/runs/view",
  "run/rerun": "actions/runs/rerun",
  "workflow/list": "actions/workflows",
  "workflow/view": "actions/workflows/view",
  "plugin/refresh": "plugin/refresh",
  "plugin/exec": "plugin/exec",
  "plugin/status": "plugin/status",
};

const NUMBERED_OPS = new Set(["comment", "ready", "close", "reopen", "merge"]);

export function mapAgentOpsPath(path: string): string | null {
  const rel = path.replace(/^\/+/, "").replace(/^agent-ops\/?/, "").replace(/\/+$/, "");
  if (!rel) return null;

  const exact = EXACT_ROUTES[rel];
  if (exact) return exact;

  const edit = /^pr\/(\d+)$/.exec(rel);
  if (edit) return `pr/${edit[1]}`;

  const op = /^pr\/(\d+)\/([a-z]+)$/.exec(rel);
  if (op && NUMBERED_OPS.has(op[2])) return `pr/${op[1]}/${op[2]}`;

  return null;
}

// Avoid fetch's default response deadline: a long operation may still be running upstream.
function requestUnbounded(
  target: string,
  method: string,
  payload: string | undefined,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const mod = url.protocol === "https:" ? https : http;
    const headers: Record<string, string | number> = { "Content-Type": "application/json" };
    if (payload !== undefined) headers["Content-Length"] = Buffer.byteLength(payload);
    const req = mod.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res: http.IncomingMessage) => {
        let data = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => { data += chunk; });
        res.on("end", () => {
          let parsed: unknown;
          try {
            parsed = data ? JSON.parse(data) : {};
          } catch {
            parsed = {};
          }
          resolve({ status: res.statusCode ?? 502, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export function localOrchestratorBaseUrl(): string {
  return `http://127.0.0.1:${process.env.PORT || "3000"}`;
}

export interface LocalAgentOpsHost {
  readonly url: string;
  close(): Promise<void>;
}

export interface StartLocalAgentOpsHostOptions {
  sessionId: string;
  orchestratorBaseUrl?: string;
}

export async function startLocalAgentOpsHost(
  opts: StartLocalAgentOpsHostOptions,
): Promise<LocalAgentOpsHost> {
  const { sessionId } = opts;
  const base = (opts.orchestratorBaseUrl ?? localOrchestratorBaseUrl()).replace(/\/$/, "");
  const app: FastifyInstance = Fastify({ logger: false });

  app.all("/agent-ops/*", async (request, reply) => {
    const suffix = mapAgentOpsPath(request.url.split("?")[0]);
    if (!suffix) {
      return reply.code(403).send({
        error: "This endpoint is not available to session containers.",
      });
    }
    const search = request.url.includes("?") ? `?${request.url.split("?").slice(1).join("?")}` : "";
    const target = `${base}/api/sessions/${encodeURIComponent(sessionId)}/${suffix}${search}`;
    const method = request.method.toUpperCase();
    const payload = method === "GET" || method === "HEAD" || request.body === undefined
      ? undefined
      : JSON.stringify(request.body);
    try {
      const res = await requestUnbounded(target, method, payload);
      return await reply.code(res.status).send(res.body ?? {});
    } catch (err) {
      return reply.code(502).send({
        error: `Could not reach the ShipIt orchestrator at ${base}: ${getErrorMessage(err)}`,
      });
    }
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  if (!port) {
    await app.close();
    throw new Error("local agent-ops host did not bind a port");
  }
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => app.close(),
  };
}

const hosts = new Map<string, LocalAgentOpsHost>();
const inFlight = new Map<string, Promise<LocalAgentOpsHost | null>>();

// Await before spawning; localAgentOpsSpawnEnv must resolve the address synchronously.
export async function ensureLocalAgentOpsHost(
  opts: StartLocalAgentOpsHostOptions,
): Promise<string | undefined> {
  const { sessionId } = opts;
  const existing = hosts.get(sessionId);
  if (existing) return existing.url;

  const pending = inFlight.get(sessionId);
  if (pending) return (await pending)?.url;

  const run = (async (): Promise<LocalAgentOpsHost | null> => {
    try {
      const host = await startLocalAgentOpsHost(opts);
      hosts.set(sessionId, host);
      console.log(`[local-agent-ops] ${sessionId} listening at ${host.url}`);
      return host;
    } catch (err) {
      console.warn(
        `[local-agent-ops] ${sessionId} failed to start, \`gh\` will be unavailable this turn: ${getErrorMessage(err)}`,
      );
      return null;
    } finally {
      inFlight.delete(sessionId);
    }
  })();
  inFlight.set(sessionId, run);
  return (await run)?.url;
}

export function localAgentOpsSpawnEnv(sessionId: string): Record<string, string> {
  const host = hosts.get(sessionId);
  return host ? { SHIPIT_AGENT_OPS_URL: host.url } : {};
}

export async function stopLocalAgentOpsHost(sessionId: string): Promise<void> {
  const host = hosts.get(sessionId);
  if (!host) return;
  hosts.delete(sessionId);
  try {
    await host.close();
  } catch (err) {
    console.warn(`[local-agent-ops] ${sessionId} close failed: ${getErrorMessage(err)}`);
  }
}

export async function resetLocalAgentOpsForTests(): Promise<void> {
  const ids = [...hosts.keys()];
  await Promise.all(ids.map((id) => stopLocalAgentOpsHost(id)));
  inFlight.clear();
}
