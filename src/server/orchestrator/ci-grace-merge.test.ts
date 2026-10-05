import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CiGraceTracker, NO_CHECKS_GRACE_MS } from "./ci-grace-tracker.js";
import { PrStatusPoller } from "./pr-status-poller.js";
import { makeGitHubAuth, makeSessionManager } from "./pr-poller-test-helpers.js";

const REPO = "acme/shipit";
const SHA = "sha-head";

function tracker() {
  return new CiGraceTracker();
}

describe("shouldWaitForMergeChecks", () => {
  it("waits on the first sight of zero checks, with no CI history at all", () => {
    const t = tracker();
    expect(t.shouldWaitForMergeChecks({ repoKey: REPO, prNumber: 7, headSha: SHA })).toBe(true);
    expect(t.shouldForcePending({ sessionId: "s1", repoKey: REPO, repoUrl: undefined, headSha: SHA })).toBe(false);
  });

  it("stops waiting once the window has passed", () => {
    const t = tracker();
    const now = 1_000_000;
    expect(t.shouldWaitForMergeChecks({ repoKey: REPO, prNumber: 7, headSha: SHA, now })).toBe(true);
    expect(t.shouldWaitForMergeChecks({
      repoKey: REPO, prNumber: 7, headSha: SHA, now: now + NO_CHECKS_GRACE_MS - 1,
    })).toBe(true);
    expect(t.shouldWaitForMergeChecks({
      repoKey: REPO, prNumber: 7, headSha: SHA, now: now + NO_CHECKS_GRACE_MS,
    })).toBe(false);
  });

  it("gives each pull request its own window, even sharing a head SHA", () => {
    const t = tracker();
    const now = 1_000_000;
    expect(t.shouldWaitForMergeChecks({ repoKey: REPO, prNumber: 7, headSha: SHA, now })).toBe(true);
    expect(t.shouldWaitForMergeChecks({
      repoKey: REPO, prNumber: 7, headSha: SHA, now: now + NO_CHECKS_GRACE_MS,
    })).toBe(false);
    expect(t.shouldWaitForMergeChecks({
      repoKey: REPO, prNumber: 8, headSha: SHA, now: now + NO_CHECKS_GRACE_MS,
    })).toBe(true);
  });

  it("gives each commit its own window", () => {
    const t = tracker();
    const now = 1_000_000;
    t.shouldWaitForMergeChecks({ repoKey: REPO, prNumber: 7, headSha: SHA, now });
    expect(t.shouldWaitForMergeChecks({
      repoKey: REPO, prNumber: 7, headSha: SHA, now: now + NO_CHECKS_GRACE_MS,
    })).toBe(false);
    expect(t.shouldWaitForMergeChecks({
      repoKey: REPO, prNumber: 7, headSha: "sha-newer", now: now + NO_CHECKS_GRACE_MS,
    })).toBe(true);
  });

  it("does not wait when the parsed workflows cannot fire for this pull request", () => {
    const t = tracker();
    t.setParsedWorkflowsForTest(REPO, [{
      unparseable: false,
      events: [{
        event: "push",
        pathsInclude: [],
        pathsIgnore: [],
        branchesInclude: ["release"],
        branchesIgnore: [],
        tagsOnly: false,
      }],
    }]);
    expect(t.shouldWaitForMergeChecks({
      repoKey: REPO, prNumber: 7, headSha: SHA, headBranch: "shipit/feature", baseBranch: "main",
    })).toBe(false);
  });

  it("still waits when a parsed workflow COULD fire", () => {
    const t = tracker();
    t.setParsedWorkflowsForTest(REPO, [{
      unparseable: false,
      events: [{
        event: "pull_request",
        pathsInclude: [],
        pathsIgnore: [],
        branchesInclude: [],
        branchesIgnore: [],
        tagsOnly: false,
      }],
    }]);
    expect(t.shouldWaitForMergeChecks({
      repoKey: REPO, prNumber: 7, headSha: SHA, headBranch: "shipit/feature", baseBranch: "main",
    })).toBe(true);
  });

  it("keeps repositories apart", () => {
    const t = tracker();
    const now = 1_000_000;
    t.shouldWaitForMergeChecks({ repoKey: REPO, prNumber: 7, headSha: SHA, now });
    expect(t.shouldWaitForMergeChecks({
      repoKey: "other/repo", prNumber: 7, headSha: SHA, now: now + NO_CHECKS_GRACE_MS,
    })).toBe(true);
  });
});

describe("a repository where nothing can report a check", () => {
  const REPO_URL = "https://github.com/acme/shipit";
  let tmpDir: string;
  let bare: string;
  let work: string;

  function git(args: string[]): string {
    const res = spawnSync("git", args, { encoding: "utf8" });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
    return res.stdout.trim();
  }

  function commit(file: string, content: string): string {
    fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
    fs.writeFileSync(path.join(work, file), content);
    git(["-C", work, "add", "-A"]);
    git(["-C", work, "commit", "--quiet", "-m", file]);
    return git(["-C", work, "rev-parse", "HEAD"]);
  }

  function publishBase(): void {
    git(["-C", work, "push", "--quiet", "--force", bare, "HEAD:refs/heads/main"]);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-grace-merge-"));
    bare = path.join(tmpDir, "cache.git");
    work = path.join(tmpDir, "work");
    git(["init", "--quiet", "--bare", bare]);
    git(["-C", bare, "symbolic-ref", "HEAD", "refs/heads/main"]);
    git(["init", "--quiet", work]);
    git(["-C", work, "config", "user.email", "t@t"]);
    git(["-C", work, "config", "user.name", "t"]);
    commit("README.md", "hi");
    publishBase();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function nothingReports(
    t: CiGraceTracker,
    headSha: string,
    reports: boolean | null = false,
    headTreeDir: string | null = work,
  ) {
    const readRepoReportsChecks = vi.fn(async () => reports);
    await t.ensureWorkflowsLoaded(REPO, REPO_URL);
    const answer = await t.nothingReportsChecks({
      repoKey: REPO, headSha, readRepoReportsChecks,
      ...(headTreeDir ? { headTreeDir } : {}),
    });
    return { answer, readRepoReportsChecks };
  }

  it("is true when no workflow file exists anywhere and no check has reported", async () => {
    const head = commit("src/a.ts", "x");
    const { answer } = await nothingReports(new CiGraceTracker(() => bare), head);
    expect(answer).toBe(true);
  });

  it("is false when the pull request's own commit adds the first workflow", async () => {
    const head = commit(".github/workflows/ci.yml", "on: pull_request\n");
    const { answer, readRepoReportsChecks } = await nothingReports(new CiGraceTracker(() => bare), head);
    expect(answer).toBe(false);
    expect(readRepoReportsChecks).not.toHaveBeenCalled();
  });

  it("is false when only the default branch has a workflow file", async () => {
    const head = commit("src/a.ts", "x");
    git(["-C", work, "checkout", "--quiet", "-b", "base-ci"]);
    commit(".github/workflows/ci.yml", "on: pull_request\n");
    publishBase();
    const { answer, readRepoReportsChecks } = await nothingReports(new CiGraceTracker(() => bare), head);
    expect(answer).toBe(false);
    expect(readRepoReportsChecks).not.toHaveBeenCalled();
  });

  it("notices a workflow added to the default branch after an empty read", async () => {
    const t = new CiGraceTracker(() => bare);
    const first = commit("src/a.ts", "x");
    expect((await nothingReports(t, first)).answer).toBe(true);

    git(["-C", work, "checkout", "--quiet", "-b", "base-ci"]);
    commit(".github/workflows/ci.yml", "on: push\n");
    publishBase();
    expect((await nothingReports(t, first)).answer).toBe(false);
  });

  it("is false when the default branch cannot be read", async () => {
    const head = commit("src/a.ts", "x");
    const { answer } = await nothingReports(new CiGraceTracker(() => path.join(tmpDir, "missing.git")), head);
    expect(answer).toBe(false);
  });

  it("is false when the head commit is not in the checkout", async () => {
    const { answer } = await nothingReports(new CiGraceTracker(() => bare), "a".repeat(40));
    expect(answer).toBe(false);
  });

  it("is false without a checkout to read the head from", async () => {
    const head = commit("src/a.ts", "x");
    const { answer } = await nothingReports(new CiGraceTracker(() => bare), head, false, null);
    expect(answer).toBe(false);
  });

  it("reads only a pinned commit id, never a ref that can move", async () => {
    commit("src/a.ts", "x");
    const { answer } = await nothingReports(new CiGraceTracker(() => bare), "HEAD");
    expect(answer).toBe(false);
  });

  it("is false, and remembered, when a check reported somewhere in the repository", async () => {
    const t = new CiGraceTracker(() => bare);
    const head = commit("src/a.ts", "x");
    expect((await nothingReports(t, head, true)).answer).toBe(false);

    const again = await nothingReports(t, head, false);
    expect(again.answer).toBe(false);
    expect(again.readRepoReportsChecks).not.toHaveBeenCalled();
  });

  it("is false when the repository's checks cannot be read", async () => {
    const head = commit("src/a.ts", "x");
    const { answer } = await nothingReports(new CiGraceTracker(() => bare), head, null);
    expect(answer).toBe(false);
  });

  it("is false when the poller has seen a check on this repository", async () => {
    const t = new CiGraceTracker(() => bare);
    t.markRepoHasChecks(REPO);
    const head = commit("src/a.ts", "x");
    expect((await nothingReports(t, head)).answer).toBe(false);
  });

  describe("PrStatusPoller.awaitCiGraceDecision", () => {
    function poller(rollup: { state: string } | null) {
      const githubAuth = makeGitHubAuth({
        data: {
          repository: {
            defaultBranchRef: { target: { statusCheckRollup: rollup } },
            pullRequests: { nodes: [] },
          },
        },
      });
      const p = new PrStatusPoller({
        githubAuth,
        sessionManager: makeSessionManager([]),
        sseBroadcast: vi.fn(),
        getSharedRepoDir: () => bare,
      });
      return { p, githubAuth };
    }

    it("does not wait, on the first call, when nothing can report a check", async () => {
      const head = commit("src/a.ts", "x");
      const { p, githubAuth } = poller(null);
      await expect(p.awaitCiGraceDecision({
        repoUrl: REPO_URL, repoKey: REPO, prNumber: 7, headSha: head, headTreeDir: work,
      })).resolves.toBe(false);
      expect(githubAuth.graphqlQuery).toHaveBeenCalledWith(
        expect.stringContaining("defaultBranchRef"), { owner: "acme", repo: "shipit" },
      );
      p.destroy();
    });

    it("waits when the default branch reports checks from outside any workflow file", async () => {
      const head = commit("src/a.ts", "x");
      const { p } = poller({ state: "SUCCESS" });
      await expect(p.awaitCiGraceDecision({
        repoUrl: REPO_URL, repoKey: REPO, prNumber: 7, headSha: head, headTreeDir: work,
      })).resolves.toBe(true);
      p.destroy();
    });

    it("waits when the caller supplies no checkout of the head", async () => {
      const head = commit("src/a.ts", "x");
      const { p, githubAuth } = poller(null);
      await expect(p.awaitCiGraceDecision({
        repoUrl: REPO_URL, repoKey: REPO, prNumber: 7, headSha: head,
      })).resolves.toBe(true);
      expect(githubAuth.graphqlQuery).not.toHaveBeenCalled();
      p.destroy();
    });
  });
});
