/**
 * `/agent-ops/*` — narrow allowlist of GitHub PR operations the agent (via the
 * `gh` shim at /usr/local/bin/gh) is permitted to invoke. The shim POSTs to
 * these endpoints over the worker's localhost interface; the worker then
 * brokers the request to the orchestrator's session-scoped routes.
 *
 * Why a broker rather than letting the shim hit the orchestrator directly?
 *
 * 1. **Allowlist gate at a single chokepoint.** The shim cannot reach
 *    arbitrary orchestrator endpoints — only what's mounted here.
 * 2. **Session-scoping is automatic.** The worker knows its session ID
 *    (`SESSION_ID` env var) and injects it into every request. The shim
 *    cannot ask for operations against a different session.
 *
 * Everything here is a thin pass-through to the orchestrator. The real
 * security gate lives on the orchestrator's API surface — this router just
 * narrows what the agent can request.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { OrchestratorClient } from "./orchestrator-client.js";
import { getErrorMessage } from "../shared/utils.js";

export interface AgentOpsDeps {
  /** Factory for the orchestrator client. Defaults to env-resolved client. */
  createOrchestratorClient?: () => OrchestratorClient;
}

/**
 * Get an OrchestratorClient lazily so missing env (e.g. in tests run outside
 * a container) doesn't crash worker startup — the error surfaces only when
 * the agent actually invokes the shim.
 */
function lazyClient(deps: AgentOpsDeps): () => OrchestratorClient | { error: string } {
  let cached: OrchestratorClient | { error: string } | null = null;
  return () => {
    if (cached) return cached;
    try {
      cached = deps.createOrchestratorClient
        ? deps.createOrchestratorClient()
        : new OrchestratorClient();
      return cached;
    } catch (err) {
      cached = { error: getErrorMessage(err) };
      return cached;
    }
  };
}

/**
 * Register the `/agent-ops/*` routes on the worker's Fastify app.
 */
export function registerAgentOpsRoutes(
  app: FastifyInstance,
  deps: AgentOpsDeps = {},
): void {
  const getClient = lazyClient(deps);

  /** Helper that pipes the orchestrator's response back to the shim 1:1. */
  async function relay(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    suffix: string,
    body: unknown,
    reply: FastifyReply,
  ): Promise<unknown> {
    const client = getClient();
    if ("error" in client) {
      reply.code(500).send({ error: `agent-ops misconfigured: ${client.error}` });
      return;
    }
    const res = await client.request(method, suffix, body);
    reply.code(res.status || (res.ok ? 200 : 502));
    return res.body ?? {};
  }

  // POST /agent-ops/pr/create — agent-driven PR create
  app.post<{ Body: {
    title?: string; body?: string; base?: string; draft?: boolean; fill?: boolean;
  } }>(
    "/agent-ops/pr/create",
    async (request, reply) => relay("POST", "/pr/agent-create", request.body ?? {}, reply),
  );

  // GET /agent-ops/pr/status — current branch's PR status (read-only)
  app.get(
    "/agent-ops/pr/status",
    async (_request, reply) => relay("GET", "/pr/status", undefined, reply),
  );

  // GET /agent-ops/pr/view?number=N — view a PR's details
  app.get<{ Querystring: { number?: string } }>(
    "/agent-ops/pr/view",
    async (request, reply) => {
      const qs = request.query.number ? `?number=${encodeURIComponent(request.query.number)}` : "";
      return relay("GET", `/pr/view${qs}`, undefined, reply);
    },
  );

  // GET /agent-ops/pr/list?state=open — list PRs for the session's repo
  app.get<{ Querystring: { state?: string } }>(
    "/agent-ops/pr/list",
    async (request, reply) => {
      const state = request.query.state;
      const qs = state ? `?state=${encodeURIComponent(state)}` : "";
      return relay("GET", `/pr/list${qs}`, undefined, reply);
    },
  );

  // PATCH /agent-ops/pr/:number — edit an existing PR
  app.patch<{ Params: { number: string }; Body: { title?: string; body?: string } }>(
    "/agent-ops/pr/:number",
    async (request, reply) =>
      relay("PATCH", `/pr/${encodeURIComponent(request.params.number)}`, request.body ?? {}, reply),
  );

  // POST /agent-ops/pr/:number/comment — add an issue-style comment
  app.post<{ Params: { number: string }; Body: { body: string } }>(
    "/agent-ops/pr/:number/comment",
    async (request, reply) =>
      relay("POST", `/pr/${encodeURIComponent(request.params.number)}/comment`, request.body ?? {}, reply),
  );

  // POST /agent-ops/pr/:number/ready — mark draft PR as ready for review
  app.post<{ Params: { number: string } }>(
    "/agent-ops/pr/:number/ready",
    async (request, reply) =>
      relay("POST", `/pr/${encodeURIComponent(request.params.number)}/ready`, {}, reply),
  );

  // POST /agent-ops/pr/:number/close — close a PR
  app.post<{ Params: { number: string } }>(
    "/agent-ops/pr/:number/close",
    async (request, reply) =>
      relay("POST", `/pr/${encodeURIComponent(request.params.number)}/close`, {}, reply),
  );

  // POST /agent-ops/pr/:number/reopen — reopen a closed PR
  app.post<{ Params: { number: string } }>(
    "/agent-ops/pr/:number/reopen",
    async (request, reply) =>
      relay("POST", `/pr/${encodeURIComponent(request.params.number)}/reopen`, {}, reply),
  );

  // POST /agent-ops/git/credential — broker a git credential for the
  // in-container `shipit-git-credential` helper (docs/088 finding #5). The
  // helper POSTs the requested host here; the orchestrator returns the GitHub
  // token (for github.com only) over this localhost channel so the PAT never
  // lands in the container's gitconfig, disk, or env.
  app.post<{ Body: { host?: string; protocol?: string } }>(
    "/agent-ops/git/credential",
    async (request, reply) => relay("POST", "/git/credential", request.body ?? {}, reply),
  );

  // ---------------------------------------------------------------------------
  // Agent-spawned sibling sessions (docs/117)
  //
  // These routes back the `shipit session create|list|view` shim subcommands.
  // The worker's `OrchestratorClient` injects this container's session id as
  // the parent — the agent cannot ask for spawns under a different parent.
  // The orchestrator additionally enforces "child must be a direct descendant
  // of parent" on every read; the worker just narrows the surface.
  // ---------------------------------------------------------------------------

  // POST /agent-ops/session/create — create a new spawned child session
  app.post<{
    Body: {
      prompt?: string;
      title?: string;
      branch?: string;
      base?: string;
      agent?: string;
      model?: string;
    };
  }>(
    "/agent-ops/session/create",
    async (request, reply) => relay("POST", "/spawn", request.body ?? {}, reply),
  );

  // GET /agent-ops/session/list — list children spawned by this parent
  app.get<{ Querystring: { turn?: string } }>(
    "/agent-ops/session/list",
    async (request, reply) => {
      const turn = request.query.turn;
      const qs = turn ? `?turn=${encodeURIComponent(turn)}` : "";
      return relay("GET", `/children${qs}`, undefined, reply);
    },
  );

  // GET /agent-ops/session/view/:childId — view a single child session
  app.get<{ Params: { childId: string } }>(
    "/agent-ops/session/view/:childId",
    async (request, reply) =>
      relay("GET", `/children/${encodeURIComponent(request.params.childId)}`, undefined, reply),
  );
}
