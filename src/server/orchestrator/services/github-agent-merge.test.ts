import { describe, it, expect, vi } from "vitest";
import { agentMergePullRequest } from "./github.js";
import type { GitManager } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";

/**
 * docs/224 — `agentMergePullRequest` backs `gh pr merge` for sandbox sessions
 * with the dangerous-ops grant. The route owns the capability gate; this service
 * owns the guardrails: green checks, no draft, no force, branch protection
 * deferred to GitHub. These tests cover each guardrail branch.
 */

const REMOTE = "https://github.com/o/r.git";

function makeGit(): GitManager {
  return {
    getRemotes: vi.fn(async () => [{ name: "origin", url: REMOTE }]),
    addRemote: vi.fn(async () => {}),
  } as unknown as GitManager;
}

type PrView = {
  url: string; number: number; base: string; head: string;
  title: string; body: string; state: "open" | "closed"; isDraft: boolean; merged: boolean;
  additions: number; deletions: number;
};

function pr(over: Partial<PrView> = {}): PrView {
  return {
    url: "https://github.com/o/r/pull/5", number: 5, base: "main", head: "feat",
    title: "T", body: "B", state: "open", isDraft: false, merged: false,
    additions: 1, deletions: 0, ...over,
  };
}

type Checks = { state: "pending" | "success" | "failure" | "none"; total: number; passed: number; failed: number; pending: number };
function checks(state: Checks["state"], over: Partial<Checks> = {}): Checks {
  return { state, total: 0, passed: 0, failed: 0, pending: 0, ...over };
}

function makeGitHub(over: Partial<Record<keyof GitHubAuthManager, unknown>> = {}): GitHubAuthManager {
  return {
    authenticated: true,
    viewPullRequest: vi.fn(async () => pr()),
    getCheckStatus: vi.fn(async () => checks("success")),
    mergePullRequest: vi.fn(async () => ({ success: true, message: "Pull request merged" })),
    enableAutoMerge: vi.fn(async () => ({ success: true, message: "Auto-merge enabled" })),
    ...over,
  } as unknown as GitHubAuthManager;
}

describe("agentMergePullRequest", () => {
  it("merges when checks are green", async () => {
    const github = makeGitHub();
    const res = await agentMergePullRequest(makeGit(), github, { number: 5, remoteUrl: REMOTE });
    expect(res.success).toBe(true);
    expect(github.mergePullRequest).toHaveBeenCalledWith("o", "r", 5, "merge");
  });

  it("forwards the chosen merge method", async () => {
    const github = makeGitHub();
    await agentMergePullRequest(makeGit(), github, { number: 5, method: "squash", remoteUrl: REMOTE });
    expect(github.mergePullRequest).toHaveBeenCalledWith("o", "r", 5, "squash");
  });

  it("merges when there are no checks configured", async () => {
    const github = makeGitHub({ getCheckStatus: vi.fn(async () => checks("none")) });
    const res = await agentMergePullRequest(makeGit(), github, { number: 5, remoteUrl: REMOTE });
    expect(res.success).toBe(true);
  });

  it("refuses a failing check and never calls merge", async () => {
    const github = makeGitHub({ getCheckStatus: vi.fn(async () => checks("failure", { failed: 2 })) });
    const res = await agentMergePullRequest(makeGit(), github, { number: 5, remoteUrl: REMOTE });
    expect(res.success).toBe(false);
    expect(res.message).toContain("failing");
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it("refuses a still-running check without --auto", async () => {
    const github = makeGitHub({ getCheckStatus: vi.fn(async () => checks("pending", { pending: 1 })) });
    const res = await agentMergePullRequest(makeGit(), github, { number: 5, remoteUrl: REMOTE });
    expect(res.success).toBe(false);
    expect(res.message).toContain("--auto");
    expect(github.mergePullRequest).not.toHaveBeenCalled();
    expect(github.enableAutoMerge).not.toHaveBeenCalled();
  });

  it("enables auto-merge on a pending check with --auto", async () => {
    const github = makeGitHub({ getCheckStatus: vi.fn(async () => checks("pending", { pending: 1 })) });
    const res = await agentMergePullRequest(makeGit(), github, { number: 5, auto: true, remoteUrl: REMOTE });
    expect(res.autoMergeEnabled).toBe(true);
    expect(github.enableAutoMerge).toHaveBeenCalledWith("o", "r", 5, "MERGE");
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it("refuses a draft PR", async () => {
    const github = makeGitHub({ viewPullRequest: vi.fn(async () => pr({ isDraft: true })) });
    const res = await agentMergePullRequest(makeGit(), github, { number: 5, remoteUrl: REMOTE });
    expect(res.success).toBe(false);
    expect(res.message).toContain("draft");
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it("reports an already-merged PR as success without re-merging", async () => {
    const github = makeGitHub({ viewPullRequest: vi.fn(async () => pr({ merged: true, state: "closed" })) });
    const res = await agentMergePullRequest(makeGit(), github, { number: 5, remoteUrl: REMOTE });
    expect(res.success).toBe(true);
    expect(res.message).toContain("already merged");
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it("surfaces GitHub's rejection verbatim (branch protection / required review)", async () => {
    const github = makeGitHub({
      mergePullRequest: vi.fn(async () => ({ success: false, message: "At least 1 approving review is required." })),
    });
    const res = await agentMergePullRequest(makeGit(), github, { number: 5, remoteUrl: REMOTE });
    expect(res.success).toBe(false);
    expect(res.message).toBe("At least 1 approving review is required.");
  });

  it("throws a 401 ServiceError when GitHub is not authenticated", async () => {
    const github = makeGitHub({ authenticated: false });
    await expect(agentMergePullRequest(makeGit(), github, { number: 5, remoteUrl: REMOTE })).rejects.toMatchObject({ statusCode: 401 });
  });
});
