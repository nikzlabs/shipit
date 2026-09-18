import { describe, it, expect } from "vitest";
import { CiGraceTracker, NO_CHECKS_GRACE_MS } from "./ci-grace-tracker.js";

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
