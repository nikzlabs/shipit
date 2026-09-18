import { describe, it, expect, vi } from "vitest";
import { rerunWorkflowRun } from "./github.js";
import type { GitManager } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { WorkflowRunSummary } from "../github-auth-actions.js";

const REMOTE = "https://github.com/o/r.git";
const BRANCH = "shipit/my-session";
const HEAD = "0123456789abcdef0123456789abcdef01234567";

function makeGit(branch: string | null = BRANCH, head: string | null = HEAD): GitManager {
  return {
    getRemotes: vi.fn(async () => [{ name: "origin", url: REMOTE }]),
    addRemote: vi.fn(async () => {}),
    currentBranchOrNull: vi.fn(async () => branch),
    getHeadHash: vi.fn(async () => head),
    // Model the legacy fallback to expose callers that mistake detached HEAD for main.
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
      message: expect.stringContaining("Actions") as unknown as string,
    });
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
