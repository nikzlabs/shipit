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
 * docs/211 — build a querystring carrying the repo-aware PR target (`cwd` +
 * `--repo`) for GET PR ops, merged with any op-specific params (`number`,
 * `state`). Only defined values are included, so a repo-bound session sends an
 * empty string and the orchestrator falls back to its session repo.
 */
function prTargetQs(
  target: { cwd?: string; repo?: string },
  extra: Record<string, string> = {},
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(extra)) {
    if (value) params.set(key, value);
  }
  if (target.cwd) params.set("cwd", target.cwd);
  if (target.repo) params.set("repo", target.repo);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
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
    opts?: { timeoutMs?: number },
  ): Promise<unknown> {
    const client = getClient();
    if ("error" in client) {
      reply.code(500).send({ error: `agent-ops misconfigured: ${client.error}` });
      return;
    }
    const res = await client.request(method, suffix, body, opts);
    reply.code(res.status || (res.ok ? 200 : 502));
    return res.body ?? {};
  }

  // POST /agent-ops/voice/note — built-in voice_note tool write-back (docs/163).
  // The consolidated `shipit` bridge forwards `voice_note` here; the worker
  // relays to the orchestrator with the trusted SESSION_ID injected. The
  // orchestrator's router decides delivery (native / external / both).
  app.post<{ Body: { summary?: string; needsAttention?: boolean; context?: unknown } }>(
    "/agent-ops/voice/note",
    async (request, reply) => relay("POST", "/voice-note", request.body ?? {}, reply),
  );

  // POST /agent-ops/bug/report — user bug filing against ShipIt (docs/164).
  // The consolidated `shipit` bridge forwards `report_shipit_bug` here; the
  // worker relays to the orchestrator with the trusted SESSION_ID injected.
  // The orchestrator redacts the draft and posts a consent card — nothing is
  // filed until the user confirms.
  app.post<{ Body: { title?: string; body?: string } }>(
    "/agent-ops/bug/report",
    async (request, reply) => relay("POST", "/bug-report", request.body ?? {}, reply),
  );

  // POST /agent-ops/propose-actions — action checklist card (docs/207 / SHI-153).
  // The consolidated `shipit` bridge forwards `propose_actions` here; the worker
  // relays to the orchestrator with the trusted SESSION_ID injected. The
  // orchestrator validates, stamps provenance, and posts a reusable
  // batch-resolve card — nothing acts until the user submits a normal turn.
  app.post<{ Body: { title?: string; actions?: unknown } }>(
    "/agent-ops/propose-actions",
    async (request, reply) => relay("POST", "/propose-actions", request.body ?? {}, reply),
  );

  // docs/211 — repo-aware PR brokering. Every PR op forwards the cwd `gh` ran
  // in and an optional `--repo` override so the orchestrator can resolve the
  // target clone (sandbox sessions clone into `/workspace/<name>` subdirs).
  // POST/PATCH carry them in the body; GET carries them as query params.

  // POST /agent-ops/pr/create — agent-driven PR create
  app.post<{ Body: {
    title?: string; body?: string; base?: string; draft?: boolean; fill?: boolean;
    labels?: string[]; cwd?: string; repo?: string;
  } }>(
    "/agent-ops/pr/create",
    async (request, reply) => relay("POST", "/pr/agent-create", request.body ?? {}, reply),
  );

  // GET /agent-ops/pr/status — current branch's PR status (read-only)
  app.get<{ Querystring: { cwd?: string; repo?: string } }>(
    "/agent-ops/pr/status",
    async (request, reply) => relay("GET", `/pr/status${prTargetQs(request.query)}`, undefined, reply),
  );

  // GET /agent-ops/pr/view?number=N — view a PR's details
  app.get<{ Querystring: { number?: string; cwd?: string; repo?: string } }>(
    "/agent-ops/pr/view",
    async (request, reply) => {
      const qs = prTargetQs(request.query, request.query.number ? { number: request.query.number } : {});
      return relay("GET", `/pr/view${qs}`, undefined, reply);
    },
  );

  // GET /agent-ops/pr/list?state=open — list PRs for the session's repo
  app.get<{ Querystring: { state?: string; cwd?: string; repo?: string } }>(
    "/agent-ops/pr/list",
    async (request, reply) => {
      const qs = prTargetQs(request.query, request.query.state ? { state: request.query.state } : {});
      return relay("GET", `/pr/list${qs}`, undefined, reply);
    },
  );

  // PATCH /agent-ops/pr/:number — edit an existing PR (title/body and/or
  // add/remove labels). The body is forwarded verbatim to the orchestrator.
  app.patch<{ Params: { number: string }; Body: { title?: string; body?: string; addLabels?: string[]; removeLabels?: string[]; cwd?: string; repo?: string } }>(
    "/agent-ops/pr/:number",
    async (request, reply) =>
      relay("PATCH", `/pr/${encodeURIComponent(request.params.number)}`, request.body ?? {}, reply),
  );

  // POST /agent-ops/pr/:number/comment — add an issue-style comment
  app.post<{ Params: { number: string }; Body: { body: string; cwd?: string; repo?: string } }>(
    "/agent-ops/pr/:number/comment",
    async (request, reply) =>
      relay("POST", `/pr/${encodeURIComponent(request.params.number)}/comment`, request.body ?? {}, reply),
  );

  // POST /agent-ops/pr/:number/ready — mark draft PR as ready for review
  app.post<{ Params: { number: string }; Body: { cwd?: string; repo?: string } }>(
    "/agent-ops/pr/:number/ready",
    async (request, reply) =>
      relay("POST", `/pr/${encodeURIComponent(request.params.number)}/ready`, request.body ?? {}, reply),
  );

  // POST /agent-ops/pr/:number/close — close a PR
  app.post<{ Params: { number: string }; Body: { cwd?: string; repo?: string } }>(
    "/agent-ops/pr/:number/close",
    async (request, reply) =>
      relay("POST", `/pr/${encodeURIComponent(request.params.number)}/close`, request.body ?? {}, reply),
  );

  // POST /agent-ops/pr/:number/reopen — reopen a closed PR
  app.post<{ Params: { number: string }; Body: { cwd?: string; repo?: string } }>(
    "/agent-ops/pr/:number/reopen",
    async (request, reply) =>
      relay("POST", `/pr/${encodeURIComponent(request.params.number)}/reopen`, request.body ?? {}, reply),
  );

  // POST /agent-ops/pr/:number/merge — merge a PR (docs/224). The orchestrator
  // gates this behind the sandbox `dangerousGitHubOps` grant and enforces the
  // green-checks / no-force guardrails; this router just narrows the surface.
  app.post<{ Params: { number: string }; Body: { method?: string; auto?: boolean; cwd?: string; repo?: string } }>(
    "/agent-ops/pr/:number/merge",
    async (request, reply) =>
      relay("POST", `/pr/${encodeURIComponent(request.params.number)}/merge`, request.body ?? {}, reply),
  );

  // ---------------------------------------------------------------------------
  // GitHub Actions reads (read-only) — back `gh run list|view` and
  // `gh workflow list|view`. Repo-aware (cwd/repo) like the PR ops. The worker
  // injects the trusted SESSION_ID; the orchestrator resolves the target repo.
  // There is intentionally NO dispatch/rerun/cancel route — manipulating CI is
  // a human/CI action, so the shim keeps those verbs blocked.
  // ---------------------------------------------------------------------------

  // GET /agent-ops/run/list — list workflow runs
  app.get<{ Querystring: { workflow?: string; branch?: string; status?: string; limit?: string; cwd?: string; repo?: string } }>(
    "/agent-ops/run/list",
    async (request, reply) => {
      const { workflow, branch, status, limit } = request.query;
      const extra: Record<string, string> = {};
      if (workflow) extra.workflow = workflow;
      if (branch) extra.branch = branch;
      if (status) extra.status = status;
      if (limit) extra.limit = limit;
      return relay("GET", `/actions/runs${prTargetQs(request.query, extra)}`, undefined, reply);
    },
  );

  // GET /agent-ops/run/view — view one run (id optional → latest)
  app.get<{ Querystring: { id?: string; log?: string; logFailed?: string; cwd?: string; repo?: string } }>(
    "/agent-ops/run/view",
    async (request, reply) => {
      const { id, log, logFailed } = request.query;
      const extra: Record<string, string> = {};
      if (id) extra.id = id;
      if (log) extra.log = log;
      if (logFailed) extra.logFailed = logFailed;
      return relay("GET", `/actions/runs/view${prTargetQs(request.query, extra)}`, undefined, reply);
    },
  );

  // GET /agent-ops/workflow/list — list workflow definitions
  app.get<{ Querystring: { cwd?: string; repo?: string } }>(
    "/agent-ops/workflow/list",
    async (request, reply) =>
      relay("GET", `/actions/workflows${prTargetQs(request.query)}`, undefined, reply),
  );

  // GET /agent-ops/workflow/view — view one workflow + recent runs
  app.get<{ Querystring: { workflow?: string; cwd?: string; repo?: string } }>(
    "/agent-ops/workflow/view",
    async (request, reply) => {
      const extra: Record<string, string> = {};
      if (request.query.workflow) extra.workflow = request.query.workflow;
      return relay("GET", `/actions/workflows/view${prTargetQs(request.query, extra)}`, undefined, reply);
    },
  );

  // POST /agent-ops/release/plan — read-only release plan (docs/214). Backs
  // `shipit release plan`. The worker injects the trusted SESSION_ID; the
  // orchestrator detects the version source + computes the next version.
  app.post<{ Body: { bump?: string; prerelease?: boolean; versionSourcePath?: string; cwd?: string; repo?: string } }>(
    "/agent-ops/release/plan",
    async (request, reply) => relay("POST", "/release/plan", request.body ?? {}, reply),
  );

  // POST /agent-ops/release/prepare — open the bump PR (final release) or cut the
  // rc tag (prerelease, confirmation-gated). Backs `shipit release prepare`.
  app.post<{
    Body: {
      bump?: string; prerelease?: boolean; pick?: string[]; from?: string;
      releaseBranch?: string; bootstrap?: boolean; confirm?: boolean;
      versionSourcePath?: string; notes?: string; cwd?: string; repo?: string;
    };
  }>(
    "/agent-ops/release/prepare",
    async (request, reply) => relay("POST", "/release/prepare", request.body ?? {}, reply),
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
  // Tracker-neutral issue access (docs/175 read + docs/177 write)
  //
  // These back the `shipit issue view|list|create|comment|edit|status|assign`
  // shim subcommands. The worker injects the trusted SESSION_ID; the orchestrator
  // resolves GitHub to the session's own repo (Linear is workspace-wide). Issue
  // creation is do-then-surface (docs/187), like the other writes — undo cancels
  // the created issue. (ShipIt *bug* filing stays human-gated; that's docs/164.)
  // ---------------------------------------------------------------------------

  // GET /agent-ops/issue/view?tracker=&id= — single issue (read)
  app.get<{ Querystring: { tracker?: string; id?: string } }>(
    "/agent-ops/issue/view",
    async (request, reply) => {
      const params = new URLSearchParams();
      if (request.query.tracker) params.set("tracker", request.query.tracker);
      if (request.query.id) params.set("id", request.query.id);
      const qs = params.toString() ? `?${params.toString()}` : "";
      return relay("GET", `/issue/view${qs}`, undefined, reply);
    },
  );

  // GET /agent-ops/issue/list?tracker=&state= — issue list (read)
  app.get<{ Querystring: { tracker?: string; state?: string } }>(
    "/agent-ops/issue/list",
    async (request, reply) => {
      const params = new URLSearchParams();
      if (request.query.tracker) params.set("tracker", request.query.tracker);
      if (request.query.state) params.set("state", request.query.state);
      const qs = params.toString() ? `?${params.toString()}` : "";
      return relay("GET", `/issue/list${qs}`, undefined, reply);
    },
  );

  // GET /agent-ops/issue/labels?tracker= — the tracker's pickable label set (read, SHI-199)
  app.get<{ Querystring: { tracker?: string } }>(
    "/agent-ops/issue/labels",
    async (request, reply) => {
      const qs = request.query.tracker ? `?tracker=${encodeURIComponent(request.query.tracker)}` : "";
      return relay("GET", `/issue/labels${qs}`, undefined, reply);
    },
  );

  // GET /agent-ops/issue/statuses?tracker= — the tracker's assignable statuses (read, SHI-199)
  app.get<{ Querystring: { tracker?: string } }>(
    "/agent-ops/issue/statuses",
    async (request, reply) => {
      const qs = request.query.tracker ? `?tracker=${encodeURIComponent(request.query.tracker)}` : "";
      return relay("GET", `/issue/statuses${qs}`, undefined, reply);
    },
  );

  // GET /agent-ops/issue/comments?tracker=&id= — issue comment thread (read, SHI-137)
  app.get<{ Querystring: { tracker?: string; id?: string } }>(
    "/agent-ops/issue/comments",
    async (request, reply) => {
      const params = new URLSearchParams();
      if (request.query.tracker) params.set("tracker", request.query.tracker);
      if (request.query.id) params.set("id", request.query.id);
      const qs = params.toString() ? `?${params.toString()}` : "";
      return relay("GET", `/issue/comments${qs}`, undefined, reply);
    },
  );

  // POST /agent-ops/issue/create { tracker, title, body, labels?, priority?, parent?, createMissingLabels? } (docs/187, SHI-92, SHI-206, SHI-230)
  app.post<{ Body: { tracker?: string; title?: string; body?: string; labels?: string[]; priority?: string; parent?: string | null; createMissingLabels?: boolean } }>(
    "/agent-ops/issue/create",
    async (request, reply) => relay("POST", "/issue/create", request.body ?? {}, reply),
  );

  // POST /agent-ops/issue/label/create { tracker, name, color?, description? } (SHI-230)
  app.post<{ Body: { tracker?: string; name?: string; color?: string; description?: string } }>(
    "/agent-ops/issue/label/create",
    async (request, reply) => relay("POST", "/issue/label/create", request.body ?? {}, reply),
  );

  // POST /agent-ops/issue/comment { tracker, id, body }
  app.post<{ Body: { tracker?: string; id?: string; body?: string } }>(
    "/agent-ops/issue/comment",
    async (request, reply) => relay("POST", "/issue/comment", request.body ?? {}, reply),
  );

  // POST /agent-ops/issue/edit { tracker, id, title?, body?, labels?, priority?, parent?, createMissingLabels? } (SHI-92, SHI-206, SHI-230)
  app.post<{ Body: { tracker?: string; id?: string; title?: string; body?: string; labels?: string[]; priority?: string; parent?: string | null; createMissingLabels?: boolean } }>(
    "/agent-ops/issue/edit",
    async (request, reply) => relay("POST", "/issue/edit", request.body ?? {}, reply),
  );

  // POST /agent-ops/issue/status { tracker, id, status }
  app.post<{ Body: { tracker?: string; id?: string; status?: string } }>(
    "/agent-ops/issue/status",
    async (request, reply) => relay("POST", "/issue/status", request.body ?? {}, reply),
  );

  // POST /agent-ops/issue/assign { tracker, id, assignee | null }
  app.post<{ Body: { tracker?: string; id?: string; assignee?: string | null } }>(
    "/agent-ops/issue/assign",
    async (request, reply) => relay("POST", "/issue/assign", request.body ?? {}, reply),
  );

  // ---------------------------------------------------------------------------
  // Read-only ShipIt source surface (docs/162)
  //
  // These back the `shipit source status|tree|search|cat` shim subcommands.
  // The worker injects the trusted SESSION_ID; the orchestrator gates every
  // route on `session.kind === "ops"`. Read-only by construction — there are
  // no source write routes.
  // ---------------------------------------------------------------------------

  // GET /agent-ops/source/status — running source ref + exactness
  app.get(
    "/agent-ops/source/status",
    async (_request, reply) => relay("GET", "/source/status", undefined, reply),
  );

  // GET /agent-ops/source/tree[?path=...] — list a directory at the source ref
  app.get<{ Querystring: { path?: string } }>(
    "/agent-ops/source/tree",
    async (request, reply) => {
      const path = request.query.path;
      const qs = path ? `?path=${encodeURIComponent(path)}` : "";
      return relay("GET", `/source/tree${qs}`, undefined, reply);
    },
  );

  // GET /agent-ops/source/search?q=...[&path=...] — git grep at the source ref
  app.get<{ Querystring: { q?: string; path?: string } }>(
    "/agent-ops/source/search",
    async (request, reply) => {
      const params = new URLSearchParams();
      if (request.query.q) params.set("q", request.query.q);
      if (request.query.path) params.set("path", request.query.path);
      const qs = params.toString() ? `?${params.toString()}` : "";
      return relay("GET", `/source/search${qs}`, undefined, reply);
    },
  );

  // GET /agent-ops/source/cat?path=... — read a file at the source ref
  app.get<{ Querystring: { path?: string } }>(
    "/agent-ops/source/cat",
    async (request, reply) => {
      const path = request.query.path;
      const qs = path ? `?path=${encodeURIComponent(path)}` : "";
      return relay("GET", `/source/cat${qs}`, undefined, reply);
    },
  );

  // GET /agent-ops/source/log[?path=...&limit=N] — commit history at the source ref
  app.get<{ Querystring: { path?: string; limit?: string } }>(
    "/agent-ops/source/log",
    async (request, reply) => {
      const params = new URLSearchParams();
      if (request.query.path) params.set("path", request.query.path);
      if (request.query.limit) params.set("limit", request.query.limit);
      const qs = params.toString() ? `?${params.toString()}` : "";
      return relay("GET", `/source/log${qs}`, undefined, reply);
    },
  );

  // GET /agent-ops/source/blame?path=... — line attribution at the source ref
  app.get<{ Querystring: { path?: string } }>(
    "/agent-ops/source/blame",
    async (request, reply) => {
      const path = request.query.path;
      const qs = path ? `?path=${encodeURIComponent(path)}` : "";
      return relay("GET", `/source/blame${qs}`, undefined, reply);
    },
  );

  // GET /agent-ops/source/show?commit=...[&path=...] — a commit's metadata + diff
  app.get<{ Querystring: { commit?: string; path?: string } }>(
    "/agent-ops/source/show",
    async (request, reply) => {
      const params = new URLSearchParams();
      if (request.query.commit) params.set("commit", request.query.commit);
      if (request.query.path) params.set("path", request.query.path);
      const qs = params.toString() ? `?${params.toString()}` : "";
      return relay("GET", `/source/show${qs}`, undefined, reply);
    },
  );

  // ---------------------------------------------------------------------------
  // Sub-agent spawning (docs/144)
  //
  // Backs the `shipit agent run` shim subcommand. The worker injects the trusted
  // SESSION_ID and relays to the orchestrator's session-scoped route, which owns
  // the setting gate, auth/pin/recursion/per-turn-cap guards, credential
  // provisioning, and the synchronous run. `depth` rides the body (the shim
  // forwards its inherited SHIPIT_AGENT_DEPTH) — the orchestrator's recursion
  // guard reads it. Unbounded timeout: a sub-agent run is long (30–120s typical,
  // up to the worker's wall-clock cap), and the orchestrator holds the request
  // open until the subprocess exits.
  // ---------------------------------------------------------------------------

  // POST /agent-ops/agent/spawn { agentId, prompt, depth }
  app.post<{ Body: { agentId?: string; prompt?: string; depth?: number } }>(
    "/agent-ops/agent/spawn",
    async (request, reply) => relay("POST", "/agent/spawn", request.body ?? {}, reply, { timeoutMs: 0 }),
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
      agent?: string;
      model?: string;
      // docs/205 — completely separate (parentless) spawn; forwarded verbatim.
      detached?: boolean;
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

  // POST /agent-ops/session/message/:childId — Phase 3 follow-up prompt
  app.post<{
    Params: { childId: string };
    Body: { text?: string };
  }>(
    "/agent-ops/session/message/:childId",
    async (request, reply) =>
      relay(
        "POST",
        `/children/${encodeURIComponent(request.params.childId)}/message`,
        request.body ?? {},
        reply,
      ),
  );

  // GET /agent-ops/session/wait/:childId[?timeout=N&segment=S] — Phase 3
  // long-poll, made resilient in docs/182. `segment` (seconds) bounds a single
  // server poll so the shim can run a resumable segment loop; it is forwarded
  // verbatim. Absent a segment, the orchestrator behaves as the legacy single
  // long-poll.
  app.get<{
    Params: { childId: string };
    Querystring: { timeout?: string; segment?: string };
  }>(
    "/agent-ops/session/wait/:childId",
    async (request, reply) => {
      const { timeout, segment } = request.query;
      const params = new URLSearchParams({ wait: "true" });
      if (timeout) params.set("timeout", timeout);
      if (segment) params.set("segment", segment);
      // docs/182 — bound the worker→orchestrator leg of a segmented poll so a
      // half-open socket fails fast (→ status 0, which the shim retries) instead
      // of hanging. Budget = segment (or overall timeout) + a margin for the
      // server's own resolve. Unbounded when neither is supplied (legacy).
      const boundSecs = Number(segment) || Number(timeout);
      const timeoutMs = Number.isFinite(boundSecs) && boundSecs > 0
        ? boundSecs * 1000 + 10_000
        : undefined;
      return relay(
        "GET",
        `/children/${encodeURIComponent(request.params.childId)}?${params.toString()}`,
        undefined,
        reply,
        timeoutMs !== undefined ? { timeoutMs } : undefined,
      );
    },
  );

  // POST /agent-ops/session/archive/:childId — Phase 3 archive
  app.post<{ Params: { childId: string } }>(
    "/agent-ops/session/archive/:childId",
    async (request, reply) =>
      relay(
        "POST",
        `/children/${encodeURIComponent(request.params.childId)}/archive`,
        {},
        reply,
      ),
  );

  // POST /agent-ops/session/notify-on-merge/:childId — docs/196. Arm an async
  // watch that wakes this parent when the child's PR merges (or closes).
  app.post<{ Params: { childId: string } }>(
    "/agent-ops/session/notify-on-merge/:childId",
    async (request, reply) =>
      relay(
        "POST",
        `/children/${encodeURIComponent(request.params.childId)}/notify-on-merge`,
        {},
        reply,
      ),
  );
}
