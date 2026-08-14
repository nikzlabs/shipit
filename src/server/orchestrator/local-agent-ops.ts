/**
 * `/agent-ops` host for `RUNTIME_MODE=local` — what makes the `gh` shim work in
 * the dogfood inner ShipIt (docs/251).
 *
 * A containerized turn gets `gh` from two pieces: the shim binary in the
 * session-worker image, and the worker's `/agent-ops/*` broker it POSTs to.
 * Local mode has no worker, so `Dockerfile.dogfood` installed no shim and a
 * dogfood turn that tried to open a PR got `gh: not found`.
 *
 * Every endpoint the `gh` shim uses is a **pure relay** — the worker's router
 * forwards it to the orchestrator's session-scoped `/api/sessions/:id/…` routes
 * and pipes the response back 1:1, holding no state of its own. (The tools that
 * genuinely need a worker — `present`, `permission_prompt`, `ask` — are served
 * by the worker itself and are NOT in scope here; they remain planning#305.) So the
 * only thing standing between local mode and a working `gh` is something that
 * accepts those paths and knows which session is asking.
 *
 * ## Why this reimplements the mapping instead of importing the worker's router
 *
 * `registerAgentOpsRoutes` lives in `session/`, and ESLint forbids
 * `orchestrator/` importing from `session/` (a deliberate, bidirectional layer
 * boundary). Local mode's established answer to exactly this problem is to
 * REIMPLEMENT the worker's behavior orchestrator-side rather than reach across:
 * `local-agent-mcp.ts` redoes the worker's two pre-spawn MCP writes, and
 * `local-agent-home.ts` redoes its credential provisioning. This module is the
 * third instance of that pattern, and the cheapest of the three — the `gh`
 * surface is sixteen path rewrites, not behavior.
 *
 * The duplication is bounded and guarded: `local-agent-ops.test.ts` reads the
 * shim's own source and asserts every `/agent-ops/…` path it can emit is one
 * this host accepts, so a new `gh` subcommand fails the build here rather than
 * silently 403-ing in the dogfood.
 *
 * ## Session binding
 *
 * One host per session, each bound to its session id at construction and
 * listening on its own loopback port; the shim is pointed at it through
 * `SHIPIT_AGENT_OPS_URL` in that session's spawn env. The session is therefore
 * a property of the LISTENER, not of the request, which is what the worker's
 * broker guarantees via its `SESSION_ID` env and what planning#305's sketch (mount
 * `/agent-ops` on the orchestrator keyed by a path segment) would have given up.
 *
 * Honest scope of that guarantee: it makes the sanctioned path session-bound.
 * It is not a sandbox. In local mode the agent shares a container with the
 * orchestrator and `registerContainerOriginGuard` is inert without a
 * `containerManager` (`api-container-guard.ts`), so a determined agent can
 * already curl `/api/sessions/<any-id>/…` directly. Closing that is a different
 * problem than this one, and it is not made worse here.
 */

import http from "node:http";
import https from "node:https";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { getErrorMessage } from "../shared/utils.js";

/**
 * Agent-ops paths with a fixed target, mapped to the orchestrator's
 * session-scoped suffix. Mirrors the worker's router; the three renames
 * (`pr/create`, and the `run`/`workflow` → `actions/*` pairs) are the worker's,
 * not ours.
 */
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
  // docs/262 req 12 — `shipit plugin refresh`. Local mode has no container, so
  // this host IS the agent-ops surface there; without the entry the shim is
  // denied in the dogfood instance while working in production, which is
  // exactly the drift the parity test exists to catch.
  //
  // NECESSARY, NOT SUFFICIENT — measured in the dogfood on 2026-08-14, so the
  // next reader does not conclude from this entry that the verb is exercisable
  // there. `Dockerfile.dogfood` installs the `gh` shim and DELIBERATELY not the
  // `shipit` one (planning#305), so an inner turn answers
  // `shipit: command not found` while `SHIPIT_AGENT_OPS_URL` is set and this
  // host is listening. The orchestrator route below it does work locally
  // (driven directly: fetch, publish, prune, an `activated` row with
  // before ≠ after). What is untested end to end in the dogfood is the shim
  // hop alone, and installing that shim is a decision planning#305 owns.
  "plugin/refresh": "plugin/refresh",
  // docs/262 req 17 — `shipit plugin exec`, the target of every generated
  // companion-CLI wrapper. Local mode has no Docker, so the orchestrator route
  // answers with a plain "this runtime cannot run plugin commands" rather than
  // a 403 that looks like a missing surface.
  "plugin/exec": "plugin/exec",
};

/** Per-PR operations reachable as `pr/<number>/<op>`. */
const NUMBERED_OPS = new Set(["comment", "ready", "close", "reopen", "merge"]);

/**
 * Map an `/agent-ops` path to the orchestrator suffix that serves it, or `null`
 * when nothing does.
 *
 * `null` is a DENY, not a fallthrough: this function is the allowlist. A path
 * absent from it is one the `gh` shim never emits, so letting it through would
 * widen what the agent can reach beyond the worker's own surface.
 */
export function mapAgentOpsPath(path: string): string | null {
  const rel = path.replace(/^\/+/, "").replace(/^agent-ops\/?/, "").replace(/\/+$/, "");
  if (!rel) return null;

  const exact = EXACT_ROUTES[rel];
  if (exact) return exact;

  // `PATCH pr/<number>` — edit title/body/labels.
  const edit = /^pr\/(\d+)$/.exec(rel);
  if (edit) return `pr/${edit[1]}`;

  // `POST pr/<number>/<op>`.
  const op = /^pr\/(\d+)\/([a-z]+)$/.exec(rel);
  if (op && NUMBERED_OPS.has(op[2])) return `pr/${op[1]}/${op[2]}`;

  return null;
}

/**
 * Relay one request with NO response deadline.
 *
 * `fetch` cannot express this: undici's `headersTimeout`/`bodyTimeout` default
 * to 300s and are per-dispatcher, not per-request, and undici is not a declared
 * dependency of this package. `node:http` has no such default, and it is what
 * `orchestrator-client.ts` already reaches for on its own unbounded path.
 */
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

/** The orchestrator's own address, as seen from inside its own container. */
export function localOrchestratorBaseUrl(): string {
  // Same resolution `container-lifecycle.ts` uses to tell a container where the
  // orchestrator is, so the two cannot drift on the default.
  return `http://127.0.0.1:${process.env.PORT || "3000"}`;
}

export interface LocalAgentOpsHost {
  /** Base URL to hand the shim via `SHIPIT_AGENT_OPS_URL`. */
  readonly url: string;
  close(): Promise<void>;
}

export interface StartLocalAgentOpsHostOptions {
  sessionId: string;
  /** Defaults to {@link localOrchestratorBaseUrl}. */
  orchestratorBaseUrl?: string;
}

/**
 * Start one session-bound `/agent-ops` host on an ephemeral loopback port.
 *
 * Exported for tests; production callers go through
 * {@link ensureLocalAgentOpsHost}, which dedupes and caches.
 */
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
      // No response deadline. `fetch` here would abort a long operation at
      // undici's 300s default while the orchestrator kept working — the shim
      // prints a failure and the change lands afterwards, which is exactly the
      // misleading outcome the unbounded transport exists to prevent. It bit
      // `plugin/refresh` first (a fetch, a checkout, and a plugin's install),
      // but nothing relayed here is inherently quick, so the deadline goes for
      // the whole relay rather than one route (review finding).
      const res = await requestUnbounded(target, method, payload);
      return await reply.code(res.status).send(res.body ?? {});
    } catch (err) {
      // Requirement 4 (docs/251): name the reason. The shim renders this
      // verbatim, so an unreachable orchestrator must not read as "no PR".
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

// ---------------------------------------------------------------------------
// Per-session registry
// ---------------------------------------------------------------------------

const hosts = new Map<string, LocalAgentOpsHost>();
const inFlight = new Map<string, Promise<LocalAgentOpsHost | null>>();

/**
 * Ensure this session has a host, and return its URL (or `undefined` if it
 * could not start).
 *
 * Single-flight on the session id, like `agents/codex/home-init.ts`: env prep
 * runs per turn and a session's second turn must not start a second listener.
 * Failures are NOT memoized, so a later turn retries.
 *
 * Awaited from `session-agent-env.ts`'s local branch — BEFORE the spawn, so the
 * URL is already in the registry when {@link localAgentOpsSpawnEnv} is read
 * from inside the (synchronous) spawn.
 */
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

/**
 * The spawn env additions for this session — `{}` when no host is running.
 *
 * Synchronous by design: the adapters spawn their child synchronously inside
 * `applyLocalMcp`'s temporary-env window, so there is nowhere to await here.
 * {@link ensureLocalAgentOpsHost} is what guarantees the entry exists by then.
 */
export function localAgentOpsSpawnEnv(sessionId: string): Record<string, string> {
  const host = hosts.get(sessionId);
  // The shim prefers this over its `127.0.0.1:$WORKER_PORT` default
  // (`session/agent-shim/shim-common.ts`), so no shim change is needed.
  return host ? { SHIPIT_AGENT_OPS_URL: host.url } : {};
}

/** Tear down a session's host. Safe to call when there isn't one. */
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

/** Test hook — close every host and clear the registry. */
export async function resetLocalAgentOpsForTests(): Promise<void> {
  const ids = [...hosts.keys()];
  await Promise.all(ids.map((id) => stopLocalAgentOpsHost(id)));
  inFlight.clear();
}
