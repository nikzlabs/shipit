// The client injects session identity; the orchestrator owns authorization and validation.

import type { FastifyInstance, FastifyReply } from "fastify";
import { OrchestratorClient } from "./orchestrator-client.js";
import { getErrorMessage } from "../shared/utils.js";

export interface AgentOpsDeps {
  createOrchestratorClient?: () => OrchestratorClient;
}

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

// Defer missing-environment errors until a shim call, rather than failing worker startup.
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

export function registerAgentOpsRoutes(
  app: FastifyInstance,
  deps: AgentOpsDeps = {},
): void {
  const getClient = lazyClient(deps);

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

  app.post<{ Body: { summary?: string; context?: unknown } }>(
    "/agent-ops/voice/note",
    async (request, reply) => relay("POST", "/voice-note", request.body ?? {}, reply),
  );

  app.post<{ Body: { title?: string; body?: string } }>(
    "/agent-ops/bug/report",
    async (request, reply) => relay("POST", "/bug-report", request.body ?? {}, reply),
  );

  app.post<{ Body: { title?: string; actions?: unknown } }>(
    "/agent-ops/propose-actions",
    async (request, reply) => relay("POST", "/propose-actions", request.body ?? {}, reply),
  );

  app.post<{ Body: {
    title?: string; body?: string; base?: string; draft?: boolean; fill?: boolean;
    labels?: string[]; cwd?: string; repo?: string;
  } }>(
    "/agent-ops/pr/create",
    async (request, reply) => relay("POST", "/pr/agent-create", request.body ?? {}, reply),
  );

  app.get<{ Querystring: { cwd?: string; repo?: string } }>(
    "/agent-ops/pr/status",
    async (request, reply) => relay("GET", `/pr/status${prTargetQs(request.query)}`, undefined, reply),
  );

  app.get<{ Querystring: { number?: string; cwd?: string; repo?: string; comments?: string } }>(
    "/agent-ops/pr/view",
    async (request, reply) => {
      const extra: Record<string, string> = {};
      if (request.query.number) extra.number = request.query.number;
      if (request.query.comments === "true") extra.comments = "true";
      const qs = prTargetQs(request.query, extra);
      return relay("GET", `/pr/view${qs}`, undefined, reply);
    },
  );

  app.get<{ Querystring: { state?: string; limit?: string; cwd?: string; repo?: string } }>(
    "/agent-ops/pr/list",
    async (request, reply) => {
      const { state, limit } = request.query;
      const extra: Record<string, string> = {};
      if (state) extra.state = state;
      if (limit) extra.limit = limit;
      return relay("GET", `/pr/list${prTargetQs(request.query, extra)}`, undefined, reply);
    },
  );

  app.patch<{ Params: { number: string }; Body: { title?: string; body?: string; addLabels?: string[]; removeLabels?: string[]; cwd?: string; repo?: string } }>(
    "/agent-ops/pr/:number",
    async (request, reply) =>
      relay("PATCH", `/pr/${encodeURIComponent(request.params.number)}`, request.body ?? {}, reply),
  );

  app.post<{ Params: { number: string }; Body: { body: string; cwd?: string; repo?: string } }>(
    "/agent-ops/pr/:number/comment",
    async (request, reply) =>
      relay("POST", `/pr/${encodeURIComponent(request.params.number)}/comment`, request.body ?? {}, reply),
  );

  app.post<{ Params: { number: string }; Body: { cwd?: string; repo?: string } }>(
    "/agent-ops/pr/:number/ready",
    async (request, reply) =>
      relay("POST", `/pr/${encodeURIComponent(request.params.number)}/ready`, request.body ?? {}, reply),
  );

  app.post<{ Params: { number: string }; Body: { cwd?: string; repo?: string } }>(
    "/agent-ops/pr/:number/close",
    async (request, reply) =>
      relay("POST", `/pr/${encodeURIComponent(request.params.number)}/close`, request.body ?? {}, reply),
  );

  app.post<{ Params: { number: string }; Body: { cwd?: string; repo?: string } }>(
    "/agent-ops/pr/:number/reopen",
    async (request, reply) =>
      relay("POST", `/pr/${encodeURIComponent(request.params.number)}/reopen`, request.body ?? {}, reply),
  );

  app.post<{ Params: { number: string }; Body: { method?: string; auto?: boolean; cwd?: string; repo?: string } }>(
    "/agent-ops/pr/:number/merge",
    async (request, reply) =>
      relay("POST", `/pr/${encodeURIComponent(request.params.number)}/merge`, request.body ?? {}, reply),
  );

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

  app.post<{ Body: { id?: string | number; failed?: boolean; cwd?: string; repo?: string } }>(
    "/agent-ops/run/rerun",
    async (request, reply) => relay("POST", "/actions/runs/rerun", request.body ?? {}, reply),
  );

  app.get<{ Querystring: { cwd?: string; repo?: string } }>(
    "/agent-ops/workflow/list",
    async (request, reply) =>
      relay("GET", `/actions/workflows${prTargetQs(request.query)}`, undefined, reply),
  );

  app.get<{ Querystring: { workflow?: string; cwd?: string; repo?: string } }>(
    "/agent-ops/workflow/view",
    async (request, reply) => {
      const extra: Record<string, string> = {};
      if (request.query.workflow) extra.workflow = request.query.workflow;
      return relay("GET", `/actions/workflows/view${prTargetQs(request.query, extra)}`, undefined, reply);
    },
  );

  app.post<{ Body: { bump?: string; prerelease?: boolean; versionSourcePath?: string; cwd?: string; repo?: string } }>(
    "/agent-ops/release/plan",
    async (request, reply) => relay("POST", "/release/plan", request.body ?? {}, reply),
  );

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

  app.post<{ Body: { host?: string; protocol?: string } }>(
    "/agent-ops/git/credential",
    async (request, reply) => relay("POST", "/git/credential", request.body ?? {}, reply),
  );

  // Plugin installs can take minutes; keep the relay unbounded.
  app.post<{ Body: { repo?: string; force?: boolean } }>(
    "/agent-ops/plugin/refresh",
    async (request, reply) =>
      relay("POST", "/plugin/refresh", {
        repo: request.body?.repo,
        force: request.body?.force === true,
      }, reply, { timeoutMs: 0 }));

  app.get<{ Querystring: { repo?: string } }>(
    "/agent-ops/plugin/status",
    async (request, reply) => {
      const repo = request.query?.repo?.trim();
      const qs = repo ? `?${new URLSearchParams({ repo }).toString()}` : "";
      return relay("GET", `/plugin/status${qs}`, undefined, reply);
    });

  app.post<{
    Body: { alias?: string; command?: string; args?: string[]; cwd?: string; stdin?: string };
  }>("/agent-ops/plugin/exec", async (request, reply) =>
    relay("POST", "/plugin/exec", {
      alias: request.body?.alias,
      command: request.body?.command,
      args: request.body?.args,
      cwd: request.body?.cwd,
      stdin: request.body?.stdin,
    }, reply, { timeoutMs: 0 }));

  app.get("/agent-ops/issue/trackers", async (_request, reply) => relay("GET", "/issue/trackers", undefined, reply));

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

  app.get<{ Querystring: { tracker?: string } }>(
    "/agent-ops/issue/labels",
    async (request, reply) => {
      const qs = request.query.tracker ? `?tracker=${encodeURIComponent(request.query.tracker)}` : "";
      return relay("GET", `/issue/labels${qs}`, undefined, reply);
    },
  );

  app.get<{ Querystring: { tracker?: string } }>(
    "/agent-ops/issue/statuses",
    async (request, reply) => {
      const qs = request.query.tracker ? `?tracker=${encodeURIComponent(request.query.tracker)}` : "";
      return relay("GET", `/issue/statuses${qs}`, undefined, reply);
    },
  );

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

  app.post<{ Body: { tracker?: string; trackerName?: string; title?: string; body?: string; labels?: string[]; priority?: string; parent?: string | null; createMissingLabels?: boolean } }>(
    "/agent-ops/issue/create",
    async (request, reply) => relay("POST", "/issue/create", request.body ?? {}, reply),
  );

  app.post<{ Body: { tracker?: string; trackerName?: string; name?: string; color?: string; description?: string } }>(
    "/agent-ops/issue/label/create",
    async (request, reply) => relay("POST", "/issue/label/create", request.body ?? {}, reply),
  );

  app.post<{ Body: { tracker?: string; trackerName?: string; name?: string; newName?: string; color?: string; description?: string } }>(
    "/agent-ops/issue/label/edit",
    async (request, reply) => relay("POST", "/issue/label/edit", request.body ?? {}, reply),
  );

  app.post<{ Body: { tracker?: string; trackerName?: string; id?: string; body?: string } }>(
    "/agent-ops/issue/comment",
    async (request, reply) => relay("POST", "/issue/comment", request.body ?? {}, reply),
  );

  app.post<{ Body: { tracker?: string; trackerName?: string; id?: string; commentId?: string; body?: string } }>(
    "/agent-ops/issue/comment/edit",
    async (request, reply) => relay("POST", "/issue/comment/edit", request.body ?? {}, reply),
  );

  app.post<{ Body: { tracker?: string; trackerName?: string; id?: string; title?: string; body?: string; labels?: string[]; priority?: string; parent?: string | null; createMissingLabels?: boolean } }>(
    "/agent-ops/issue/edit",
    async (request, reply) => relay("POST", "/issue/edit", request.body ?? {}, reply),
  );

  app.post<{ Body: { tracker?: string; trackerName?: string; id?: string; status?: string } }>(
    "/agent-ops/issue/status",
    async (request, reply) => relay("POST", "/issue/status", request.body ?? {}, reply),
  );

  app.post<{ Body: { tracker?: string; trackerName?: string; id?: string; assignee?: string | null } }>(
    "/agent-ops/issue/assign",
    async (request, reply) => relay("POST", "/issue/assign", request.body ?? {}, reply),
  );

  app.get(
    "/agent-ops/source/status",
    async (_request, reply) => relay("GET", "/source/status", undefined, reply),
  );

  app.get<{ Querystring: { path?: string } }>(
    "/agent-ops/source/tree",
    async (request, reply) => {
      const path = request.query.path;
      const qs = path ? `?path=${encodeURIComponent(path)}` : "";
      return relay("GET", `/source/tree${qs}`, undefined, reply);
    },
  );

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

  app.get<{ Querystring: { path?: string } }>(
    "/agent-ops/source/cat",
    async (request, reply) => {
      const path = request.query.path;
      const qs = path ? `?path=${encodeURIComponent(path)}` : "";
      return relay("GET", `/source/cat${qs}`, undefined, reply);
    },
  );

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

  app.get<{ Querystring: { path?: string } }>(
    "/agent-ops/source/blame",
    async (request, reply) => {
      const path = request.query.path;
      const qs = path ? `?path=${encodeURIComponent(path)}` : "";
      return relay("GET", `/source/blame${qs}`, undefined, reply);
    },
  );

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

  app.post<{
    Body: {
      prompt?: string;
      depth?: number;
      role?: string;
      agentId?: string;
      serviceId?: string;
      billingMode?: string;
      modelId?: string;
      reasoningEffort?: string;
    };
  }>(
    "/agent-ops/agent/spawn",
    async (request, reply) => relay("POST", "/agent/spawn", request.body ?? {}, reply, { timeoutMs: 0 }),
  );

  app.get("/agent-ops/agent/roles", async (_request, reply) => relay("GET", "/agent/roles", undefined, reply));

  app.get("/agent-ops/agent/params", async (_request, reply) => relay("GET", "/agent/params", undefined, reply));

  app.get<{ Querystring: { spawnId?: string; wait?: string; timeout?: string; segment?: string } }>(
    "/agent-ops/agent/result",
    async (request, reply) => {
      const { spawnId, wait, timeout, segment } = request.query;
      const params = new URLSearchParams();
      if (spawnId) params.set("spawnId", spawnId);
      if (wait === "true") params.set("wait", "true");
      if (timeout) params.set("timeout", timeout);
      if (segment) params.set("segment", segment);
      const qs = params.toString();
      // Bound half-open sockets while allowing the server's segment timer to finish first.
      const boundSecs = wait === "true" ? Number(segment) || Number(timeout) : NaN;
      const timeoutMs = Number.isFinite(boundSecs) && boundSecs > 0
        ? boundSecs * 1000 + 10_000
        : undefined;
      return relay(
        "GET",
        `/agent/result${qs ? `?${qs}` : ""}`,
        undefined,
        reply,
        timeoutMs !== undefined ? { timeoutMs } : undefined,
      );
    },
  );

  app.post<{
    Body: {
      prompt?: string;
      title?: string;
      agent?: string;
      model?: string;
      role?: string;
      agentId?: string;
      serviceId?: string;
      billingMode?: string;
      modelId?: string;
      reasoningEffort?: string;
      noRole?: boolean;
      detached?: boolean;
    };
  }>(
    "/agent-ops/session/create",
    async (request, reply) => relay("POST", "/spawn", request.body ?? {}, reply),
  );

  app.get<{ Querystring: { turn?: string } }>(
    "/agent-ops/session/list",
    async (request, reply) => {
      const turn = request.query.turn;
      const qs = turn ? `?turn=${encodeURIComponent(turn)}` : "";
      return relay("GET", `/children${qs}`, undefined, reply);
    },
  );

  app.get<{
    Querystring: {
      branch?: string;
      pr?: string;
      container?: string;
      id?: string;
      includeArchived?: string;
      includeWarm?: string;
      limit?: string;
      offset?: string;
    };
  }>(
    "/agent-ops/session/host-sessions",
    async (request, reply) => {
      const params = new URLSearchParams();
      for (const key of [
        "branch", "pr", "container", "id", "includeArchived", "includeWarm", "limit", "offset",
      ] as const) {
        const value = request.query[key];
        if (value) params.set(key, value);
      }
      const qs = params.toString() ? `?${params.toString()}` : "";
      return relay("GET", `/host-sessions${qs}`, undefined, reply);
    },
  );

  app.get<{
    Querystring: { target?: string; since?: string; until?: string; lines?: string };
  }>(
    "/agent-ops/session/host-session-logs",
    async (request, reply) => {
      const params = new URLSearchParams();
      for (const key of ["target", "since", "until", "lines"] as const) {
        const value = request.query[key];
        if (value) params.set(key, value);
      }
      const qs = params.toString() ? `?${params.toString()}` : "";
      return relay("GET", `/host-session-logs${qs}`, undefined, reply);
    },
  );

  app.get<{ Params: { childId: string } }>(
    "/agent-ops/session/view/:childId",
    async (request, reply) =>
      relay("GET", `/children/${encodeURIComponent(request.params.childId)}`, undefined, reply),
  );

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

  app.post(
    "/agent-ops/session/notify-on-merge-self",
    async (_request, reply) => relay("POST", "/notify-on-merge-self", {}, reply),
  );

  app.post<{ Body: { title?: string } }>(
    "/agent-ops/session/rename",
    async (request, reply) => relay("POST", "/rename", request.body ?? {}, reply),
  );

  app.post<{ Body: { force?: boolean; reason?: string } }>(
    "/agent-ops/branch/reset-to-base",
    async (request, reply) => relay("POST", "/branch/reset-to-base", request.body ?? {}, reply),
  );

  app.get(
    "/agent-ops/session/cohort",
    async (_request, reply) => relay("GET", "/cohort", undefined, reply),
  );

  app.post<{ Body: { body?: string; subject?: string; severity?: string; to?: string } }>(
    "/agent-ops/session/report",
    async (request, reply) => relay("POST", "/report", request.body ?? {}, reply),
  );
}
