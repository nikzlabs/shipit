/**
 * GitHub Actions workflow operations — reads, plus re-running an existing run.
 *
 * Backs the `gh run list|view|rerun` and `gh workflow list|view` shim
 * subcommands. The agent inside a session container can read manually-dispatched
 * (`workflow_dispatch`) and other workflow runs, see their status/conclusion,
 * pull job logs, and re-run one — all brokered through the orchestrator so the
 * GitHub token never enters the container.
 *
 * **Where the write boundary sits.** `rerun` re-executes workflow content that
 * is already committed and already ran, against a commit that already exists.
 * It introduces no new code, selects no new workflow, and destroys nothing —
 * the agent already causes those same workflows to execute on every turn via
 * auto-push, so the only thing blocking `rerun` bought was that the agent had to
 * pollute branch history with an empty commit to get the same effect. The verbs
 * that genuinely *are* new authority stay unimplemented here and blocked at the
 * shim: `gh workflow run` (dispatch an arbitrary workflow — effectively
 * arbitrary execution with repo secrets), `gh run cancel` and `gh run delete`
 * (destroy state). See `/shipit-docs/github.md` for the agent-facing statement
 * of the same line.
 *
 * Like the sibling `github-auth-{checks,releases,prs}.ts` modules, these are
 * thin `fetchGitHub` wrappers. Reads that target a collection throw on a
 * non-2xx response (so the service can surface GitHub's own error — e.g. a
 * token missing the `actions:read` scope, or Actions disabled on the repo —
 * rather than a misleading empty list); single-resource reads return `null` on
 * a 404 so "not found" is a clean result, not an error. The one write returns a
 * status-bearing result rather than throwing, so the service can turn GitHub's
 * 403 into an actionable message about token scope.
 */

import { fetchGitHub, parseGitHubError } from "./github-api.js";

/** A workflow run, normalized to fields that mirror `gh run --json` names. */
export interface WorkflowRunSummary {
  /** The run's numeric id (`gh` calls this `databaseId`). */
  databaseId: number;
  /** The per-workflow run number (`gh` calls this `number`). */
  number: number;
  /** Display title of the run (commit subject or dispatch title). */
  displayTitle: string;
  /** The workflow's display name. `gh` exposes this as both `name` and `workflowName`. */
  workflowName: string;
  /** The workflow definition's numeric id. */
  workflowDatabaseId: number;
  headBranch: string;
  headSha: string;
  /** The triggering event, e.g. `workflow_dispatch`, `push`, `pull_request`. */
  event: string;
  /** queued | in_progress | completed | … */
  status: string;
  /** success | failure | cancelled | … (null until the run completes). */
  conclusion: string | null;
  createdAt: string;
  updatedAt: string;
  /** Link-out to the run on GitHub (escape hatch only). */
  url: string;
}

/** A single job within a run. */
export interface WorkflowJobSummary {
  databaseId: number;
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
  startedAt: string | null;
  completedAt: string | null;
}

/** A workflow definition. */
export interface WorkflowSummary {
  id: number;
  name: string;
  /** Repo-relative path, e.g. `.github/workflows/ci.yml`. */
  path: string;
  /** active | disabled_manually | disabled_inactivity | … */
  state: string;
  url: string;
}

interface RawRun {
  id: number;
  name: string | null;
  run_number: number;
  display_title?: string;
  workflow_id: number;
  head_branch: string | null;
  head_sha: string;
  event: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
}

function mapRun(r: RawRun): WorkflowRunSummary {
  const workflowName = r.name ?? "";
  return {
    databaseId: r.id,
    number: r.run_number,
    displayTitle: r.display_title ?? r.name ?? "",
    workflowName,
    workflowDatabaseId: r.workflow_id,
    headBranch: r.head_branch ?? "",
    headSha: r.head_sha,
    event: r.event,
    status: r.status,
    conclusion: r.conclusion,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    url: r.html_url,
  };
}

/**
 * List workflow runs for a repo, most-recent first.
 *
 * `workflowFile` (a numeric id or workflow filename like `ci.yml`) scopes the
 * query to a single workflow via the `actions/workflows/{id}/runs` endpoint;
 * without it the repo-wide `actions/runs` endpoint is used. `branch`/`status`
 * map to GitHub's query filters. Throws on a non-2xx response.
 */
export async function listWorkflowRuns(
  token: string,
  owner: string,
  repo: string,
  opts: { workflowFile?: string; branch?: string; status?: string; limit?: number } = {},
): Promise<WorkflowRunSummary[]> {
  const perPage = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const params = new URLSearchParams({ per_page: String(perPage) });
  if (opts.branch) params.set("branch", opts.branch);
  if (opts.status) params.set("status", opts.status);

  const base = opts.workflowFile
    ? `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(opts.workflowFile)}/runs`
    : `https://api.github.com/repos/${owner}/${repo}/actions/runs`;

  const res = await fetchGitHub(`${base}?${params.toString()}`, token);
  if (!res.ok) throw new Error(await parseGitHubError(res));
  const data = (await res.json()) as { workflow_runs?: RawRun[] };
  return (data.workflow_runs ?? []).map(mapRun);
}

/**
 * Fetch a single workflow run by id. Returns `null` on 404 (clean "not found"),
 * throws on other non-2xx responses.
 */
export async function getWorkflowRun(
  token: string,
  owner: string,
  repo: string,
  runId: number,
): Promise<WorkflowRunSummary | null> {
  const res = await fetchGitHub(
    `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}`,
    token,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await parseGitHubError(res));
  return mapRun((await res.json()) as RawRun);
}

/** List the jobs for a workflow run. Throws on a non-2xx response. */
export async function listWorkflowRunJobs(
  token: string,
  owner: string,
  repo: string,
  runId: number,
): Promise<WorkflowJobSummary[]> {
  const res = await fetchGitHub(
    `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100`,
    token,
  );
  if (!res.ok) throw new Error(await parseGitHubError(res));
  const data = (await res.json()) as {
    jobs?: {
      id: number;
      name: string;
      status: string;
      conclusion: string | null;
      html_url: string;
      started_at: string | null;
      completed_at: string | null;
    }[];
  };
  return (data.jobs ?? []).map((j) => ({
    databaseId: j.id,
    name: j.name,
    status: j.status,
    conclusion: j.conclusion,
    url: j.html_url,
    startedAt: j.started_at,
    completedAt: j.completed_at,
  }));
}

/** Outcome of a re-run request. Status-bearing so callers can special-case 403. */
export interface RerunWorkflowRunResult {
  ok: boolean;
  /** The HTTP status GitHub returned. */
  status: number;
  /** GitHub's own error message; empty on success. */
  message: string;
}

/**
 * Re-run an existing workflow run.
 *
 * `onlyFailed` selects GitHub's `rerun-failed-jobs` endpoint (re-run just the
 * failed jobs and their dependents) instead of `rerun` (the whole run). Both
 * return 201 with an empty body on success.
 *
 * Unlike the reads above this does NOT throw on a non-2xx: the caller needs the
 * status to distinguish "token can't write Actions" (403) from GitHub refusing
 * the run itself (also 403 — e.g. a run too old to re-run, or one with no failed
 * jobs), and both need a better message than a raw API dump.
 */
export async function rerunWorkflowRun(
  token: string,
  owner: string,
  repo: string,
  runId: number,
  opts: { onlyFailed?: boolean } = {},
): Promise<RerunWorkflowRunResult> {
  const endpoint = opts.onlyFailed ? "rerun-failed-jobs" : "rerun";
  const res = await fetchGitHub(
    `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/${endpoint}`,
    token,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  );
  if (res.ok) return { ok: true, status: res.status, message: "" };
  return { ok: false, status: res.status, message: await parseGitHubError(res) };
}

/** List the repo's workflow definitions. Throws on a non-2xx response. */
export async function listWorkflows(
  token: string,
  owner: string,
  repo: string,
): Promise<WorkflowSummary[]> {
  const res = await fetchGitHub(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows?per_page=100`,
    token,
  );
  if (!res.ok) throw new Error(await parseGitHubError(res));
  const data = (await res.json()) as {
    workflows?: { id: number; name: string; path: string; state: string; html_url: string }[];
  };
  return (data.workflows ?? []).map((w) => ({
    id: w.id,
    name: w.name,
    path: w.path,
    state: w.state,
    url: w.html_url,
  }));
}

/**
 * Fetch a single workflow definition by numeric id or filename (`ci.yml`).
 * Returns `null` on 404, throws on other non-2xx responses.
 */
export async function getWorkflow(
  token: string,
  owner: string,
  repo: string,
  idOrFile: string,
): Promise<WorkflowSummary | null> {
  const res = await fetchGitHub(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(idOrFile)}`,
    token,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await parseGitHubError(res));
  const w = (await res.json()) as { id: number; name: string; path: string; state: string; html_url: string };
  return { id: w.id, name: w.name, path: w.path, state: w.state, url: w.html_url };
}
