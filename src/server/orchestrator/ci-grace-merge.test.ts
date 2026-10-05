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

describe("a pull request with no workflow file to fire", () => {
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

  async function noWorkflowFiles(t: CiGraceTracker, headSha: string, headTreeDir: string | null = work) {
    await t.ensureWorkflowsLoaded(REPO, REPO_URL);
    return t.noWorkflowFiles({ repoKey: REPO, headSha, ...(headTreeDir ? { headTreeDir } : {}) });
  }

  it("is true when neither the default branch nor the head has a workflow file", async () => {
    const head = commit("src/a.ts", "x");
    expect(await noWorkflowFiles(new CiGraceTracker(() => bare), head)).toBe(true);
  });

  it("is false when the pull request's own commit adds the first workflow", async () => {
    const head = commit(".github/workflows/ci.yml", "on: pull_request\n");
    expect(await noWorkflowFiles(new CiGraceTracker(() => bare), head)).toBe(false);
  });

  it("sees a workflow file whose name git would quote", async () => {
    const head = commit(".github/workflows/prüfung.yml", "on: pull_request\n");
    expect(await noWorkflowFiles(new CiGraceTracker(() => bare), head)).toBe(false);
  });

  it("is false when only the default branch has a workflow file", async () => {
    const head = commit("src/a.ts", "x");
    git(["-C", work, "checkout", "--quiet", "-b", "base-ci"]);
    commit(".github/workflows/ci.yml", "on: pull_request\n");
    publishBase();
    expect(await noWorkflowFiles(new CiGraceTracker(() => bare), head)).toBe(false);
  });

  it("notices a workflow added to the default branch after an empty read", async () => {
    const t = new CiGraceTracker(() => bare);
    const first = commit("src/a.ts", "x");
    expect(await noWorkflowFiles(t, first)).toBe(true);

    git(["-C", work, "checkout", "--quiet", "-b", "base-ci"]);
    commit(".github/workflows/ci.yml", "on: push\n");
    publishBase();
    expect(await noWorkflowFiles(t, first)).toBe(false);
  });

  it("is false when the default branch cannot be read", async () => {
    const head = commit("src/a.ts", "x");
    expect(await noWorkflowFiles(new CiGraceTracker(() => path.join(tmpDir, "missing.git")), head)).toBe(false);
  });

  it("is false when the head commit is not in the checkout", async () => {
    expect(await noWorkflowFiles(new CiGraceTracker(() => bare), "a".repeat(40))).toBe(false);
  });

  it("is false without a checkout to read the head from", async () => {
    const head = commit("src/a.ts", "x");
    expect(await noWorkflowFiles(new CiGraceTracker(() => bare), head, null)).toBe(false);
  });

  it("reads only a pinned commit id, never a ref that can move", async () => {
    commit("src/a.ts", "x");
    expect(await noWorkflowFiles(new CiGraceTracker(() => bare), "HEAD")).toBe(false);
  });

  describe("PrStatusPoller.awaitCiGraceDecision", () => {
    function poller() {
      return new PrStatusPoller({
        githubAuth: makeGitHubAuth(),
        sessionManager: makeSessionManager([]),
        sseBroadcast: vi.fn(),
        getSharedRepoDir: () => bare,
      });
    }

    it("does not wait, on the first call, when no workflow file can fire", async () => {
      const head = commit("src/a.ts", "x");
      const p = poller();
      await expect(p.awaitCiGraceDecision({
        repoUrl: REPO_URL, repoKey: REPO, prNumber: 7, headSha: head, headTreeDir: work,
      })).resolves.toBe(false);
      p.destroy();
    });

    it("waits when the caller supplies no checkout of the head", async () => {
      const head = commit("src/a.ts", "x");
      const p = poller();
      await expect(p.awaitCiGraceDecision({
        repoUrl: REPO_URL, repoKey: REPO, prNumber: 7, headSha: head,
      })).resolves.toBe(true);
      p.destroy();
    });
  });
});
