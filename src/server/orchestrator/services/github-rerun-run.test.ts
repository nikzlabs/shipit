import { describe, it, expect, vi } from "vitest";
import { rerunWorkflowRun } from "./github.js";
import type { GitManager } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { WorkflowRunSummary } from "../github-auth-actions.js";

/**
 * `rerunWorkflowRun` backs `gh run rerun` — the only Actions *write* the agent
 * gets. The route owns nothing but id parsing; this service owns the three
 * guardrails the whole capability rests on, each closing a way the run could be
 * something OTHER than "CI the agent's own push already caused":
 *
 *   1. same branch  — else an explicit id re-executes a merged deploy/release
 *      workflow on main/stable;
 *   2. same commit  — GitHub re-runs against the run's ORIGINAL commit, so
 *      without this the agent replays an arbitrary historical tree;
 *   3. push/PR only — a `workflow_dispatch` run was started by a human, and
 *      replaying it is dispatching by proxy (which the shim cannot do directly).
 *
 * (1) and (2) are both load-bearing: a fresh session branch shares a SHA with
 * its base branch's tip, so SHA alone would authorize main's run.
 */

const REMOTE = "https://github.com/o/r.git";
const BRANCH = "shipit/my-session";
const HEAD = "0123456789abcdef0123456789abcdef01234567";

function makeGit(branch: string | null = BRANCH, head: string | null = HEAD): GitManager {
  return {
    getRemotes: vi.fn(async () => [{ name: "origin", url: REMOTE }]),
    addRemote: vi.fn(async () => {}),
    currentBranchOrNull: vi.fn(async () => branch),
    getHeadHash: vi.fn(async () => head),
    // Present but must NOT be what the guard reads — it masks a detached HEAD
    // as "main", which would authorize re-running main's runs.
    getCurrentBranch: vi.fn(async () => branch ?? "main"),
  } as unknown as GitManager;
}

function run(over: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    databaseId: 42, number: 7, displayTitle: "Fix things", workflowName: "CI",
    workflowDatabaseId: 1, headBranch: BRANCH, headSha: HEAD, event: "pull_request",
    status: "completed", conclusion: "failure",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:05:00Z",
    url: "https://github.com/o/r/actions/runs/42",
    ...over,
  };
}

function makeGitHub(over: Partial<Record<keyof GitHubAuthManager, unknown>> = {}): GitHubAuthManager {
  return {
    authenticated: true,
    listWorkflowRuns: vi.fn(async () => [run()]),
    getWorkflowRun: vi.fn(async () => run()),
    rerunWorkflowRun: vi.fn(async () => ({ ok: true, status: 201, message: "" })),
    ...over,
  } as unknown as GitHubAuthManager;
}

describe("rerunWorkflowRun", () => {
  it("re-runs the latest run for the current branch when no id is given", async () => {
    const github = makeGitHub();
    const res = await rerunWorkflowRun(makeGit(), github, { remoteUrl: REMOTE });

    expect(res.run.databaseId).toBe(42);
    expect(res.onlyFailed).toBe(false);
    // Scoped to the session's branch, not "latest run overall" — `viewWorkflowRun`
    // falls back to the latter, which for a write would escape the branch scope.
    expect(github.listWorkflowRuns).toHaveBeenCalledWith("o", "r", { branch: BRANCH, limit: 1 });
    expect(github.rerunWorkflowRun).toHaveBeenCalledWith("o", "r", 42, { onlyFailed: false });
  });

  it("maps --failed onto the rerun-failed-jobs request", async () => {
    const github = makeGitHub();
    const res = await rerunWorkflowRun(makeGit(), github, { onlyFailed: true, remoteUrl: REMOTE });

    expect(res.onlyFailed).toBe(true);
    expect(github.rerunWorkflowRun).toHaveBeenCalledWith("o", "r", 42, { onlyFailed: true });
  });

  it("accepts an explicit run id on the session's own branch", async () => {
    const github = makeGitHub({ getWorkflowRun: vi.fn(async () => run({ databaseId: 99 })) });
    const res = await rerunWorkflowRun(makeGit(), github, { runId: 99, remoteUrl: REMOTE });

    expect(res.run.databaseId).toBe(99);
    expect(github.getWorkflowRun).toHaveBeenCalledWith("o", "r", 99);
    expect(github.listWorkflowRuns).not.toHaveBeenCalled();
    expect(github.rerunWorkflowRun).toHaveBeenCalledWith("o", "r", 99, { onlyFailed: false });
  });

  it("refuses a run on another branch and never calls GitHub's rerun", async () => {
    // The guardrail: re-running `stable`'s merge run would re-execute the release
    // workflow, which is exactly the human/CI act this capability does NOT cover.
    const github = makeGitHub({ getWorkflowRun: vi.fn(async () => run({ headBranch: "stable" })) });
    await expect(rerunWorkflowRun(makeGit(), github, { runId: 42, remoteUrl: REMOTE }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(github.rerunWorkflowRun).not.toHaveBeenCalled();
  });

  it("names both branches when it refuses", async () => {
    const github = makeGitHub({ getWorkflowRun: vi.fn(async () => run({ headBranch: "main" })) });
    await expect(rerunWorkflowRun(makeGit(), github, { runId: 42, remoteUrl: REMOTE }))
      .rejects.toMatchObject({ message: expect.stringContaining('"main"') as unknown as string });
    await expect(rerunWorkflowRun(makeGit(), github, { runId: 42, remoteUrl: REMOTE }))
      .rejects.toMatchObject({ message: expect.stringContaining(BRANCH) as unknown as string });
  });

  it("refuses a run for an older commit on the same branch", async () => {
    // GitHub re-runs against the run's ORIGINAL GITHUB_SHA, so this would replay
    // a tree the agent could not reach by pushing.
    const github = makeGitHub({ getWorkflowRun: vi.fn(async () => run({ headSha: "f".repeat(40) })) });
    await expect(rerunWorkflowRun(makeGit(), github, { runId: 42, remoteUrl: REMOTE }))
      .rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining("Push the current branch") as unknown as string });
    expect(github.rerunWorkflowRun).not.toHaveBeenCalled();
  });

  it("refuses a workflow_dispatch run — replaying one is dispatching by proxy", async () => {
    const github = makeGitHub({ getWorkflowRun: vi.fn(async () => run({ event: "workflow_dispatch" })) });
    await expect(rerunWorkflowRun(makeGit(), github, { runId: 42, remoteUrl: REMOTE }))
      .rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining("workflow_dispatch") as unknown as string });
    expect(github.rerunWorkflowRun).not.toHaveBeenCalled();
  });

  it("allows a push-triggered run, not just pull_request", async () => {
    const github = makeGitHub({ listWorkflowRuns: vi.fn(async () => [run({ event: "push" })]) });
    await expect(rerunWorkflowRun(makeGit(), github, { remoteUrl: REMOTE })).resolves.toMatchObject({ onlyFailed: false });
    expect(github.rerunWorkflowRun).toHaveBeenCalled();
  });

  it("applies every guardrail to the no-id path too, not just an explicit id", async () => {
    // The latest run on the branch can still be a human's dispatch at an old SHA.
    const github = makeGitHub({
      listWorkflowRuns: vi.fn(async () => [run({ event: "workflow_dispatch", headSha: "e".repeat(40) })]),
    });
    await expect(rerunWorkflowRun(makeGit(), github, { remoteUrl: REMOTE }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(github.rerunWorkflowRun).not.toHaveBeenCalled();
  });

  it("refuses when HEAD cannot be resolved", async () => {
    const github = makeGitHub();
    await expect(rerunWorkflowRun(makeGit(BRANCH, null), github, { runId: 42, remoteUrl: REMOTE }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(github.rerunWorkflowRun).not.toHaveBeenCalled();
  });

  it("refuses on a detached HEAD instead of falling back to \"main\"", async () => {
    // `getCurrentBranch()` answers "main" for a detached HEAD, which would make
    // the branch comparison authorize exactly the runs it exists to refuse.
    const github = makeGitHub({ getWorkflowRun: vi.fn(async () => run({ headBranch: "main" })) });
    await expect(rerunWorkflowRun(makeGit(null), github, { runId: 42, remoteUrl: REMOTE }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(github.rerunWorkflowRun).not.toHaveBeenCalled();
  });

  it("404s when the branch has no runs, rather than reaching for another branch's", async () => {
    const github = makeGitHub({ listWorkflowRuns: vi.fn(async () => []) });
    await expect(rerunWorkflowRun(makeGit(), github, { remoteUrl: REMOTE }))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(github.rerunWorkflowRun).not.toHaveBeenCalled();
  });

  it("404s when an explicit run id does not exist", async () => {
    const github = makeGitHub({ getWorkflowRun: vi.fn(async () => null) });
    await expect(rerunWorkflowRun(makeGit(), github, { runId: 7, remoteUrl: REMOTE }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it("turns GitHub's 403 into an actionable message naming both causes", async () => {
    const github = makeGitHub({
      rerunWorkflowRun: vi.fn(async () => ({ ok: false, status: 403, message: "Resource not accessible by integration" })),
    });
    await expect(rerunWorkflowRun(makeGit(), github, { remoteUrl: REMOTE })).rejects.toMatchObject({
      statusCode: 403,
      // Token scope (fine-grained PATs need Actions: Read and write) …
      message: expect.stringContaining("Actions") as unknown as string,
    });
    // … and GitHub refusing this particular run, so the agent knows which to check.
    await expect(rerunWorkflowRun(makeGit(), github, { remoteUrl: REMOTE })).rejects.toMatchObject({
      message: expect.stringContaining("gh run view 42") as unknown as string,
    });
  });

  it("surfaces a non-403 GitHub failure verbatim", async () => {
    const github = makeGitHub({
      rerunWorkflowRun: vi.fn(async () => ({ ok: false, status: 422, message: "Unable to retry this workflow run" })),
    });
    await expect(rerunWorkflowRun(makeGit(), github, { remoteUrl: REMOTE })).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringContaining("Unable to retry this workflow run") as unknown as string,
    });
  });

  it("throws a 401 ServiceError when GitHub is not connected", async () => {
    const github = makeGitHub({ authenticated: false });
    await expect(rerunWorkflowRun(makeGit(), github, { remoteUrl: REMOTE }))
      .rejects.toMatchObject({ statusCode: 401 });
  });
});
