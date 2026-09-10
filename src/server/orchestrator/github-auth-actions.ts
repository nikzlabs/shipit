import { fetchGitHub, parseGitHubError } from "./github-api.js";

export interface WorkflowRunSummary {
  databaseId: number;
  number: number;
  displayTitle: string;
  workflowName: string;
  workflowDatabaseId: number;
  headBranch: string;
  headSha: string;
  event: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface WorkflowJobSummary {
  databaseId: number;
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface WorkflowSummary {
  id: number;
  name: string;
  path: string;
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

export interface RerunWorkflowRunResult {
  ok: boolean;
  status: number;
  message: string;
}

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
