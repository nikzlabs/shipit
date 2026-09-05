import { describe, it, expect } from "vitest";
import { CiGraceTracker, NO_CHECKS_GRACE_MS } from "./ci-grace-tracker.js";

/**
 * docs/287-agent-merge-per-repo — the merge decision's zero-check grace.
 *
 * It answers the same question as `shouldForcePending`, and differs in the one
 * place that matters: the poller returns false for a repository whose CI history
 * it does not know, because it will see that repository again in seconds and can
 * revise. A merge is one-shot and irreversible, so "we do not know yet whether
 * this repository runs CI" must not read as "it does not".
 */

const REPO = "acme/shipit";
const SHA = "sha-head";

function tracker() {
  return new CiGraceTracker();
}

describe("shouldWaitForMergeChecks", () => {
  it("waits on the first sight of zero checks, with no CI history at all", () => {
    // The behavioural difference from the poller's own answer, which is false
    // here. Asserted alongside it so the divergence is deliberate and visible.
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
    // Two pull requests in one repository can sit on the same commit (a branch
    // pushed twice, a stacked pair). Keying by SHA alone would let the first
    // one's expired window merge the second immediately.
    const t = tracker();
    const now = 1_000_000;
    expect(t.shouldWaitForMergeChecks({ repoKey: REPO, prNumber: 7, headSha: SHA, now })).toBe(true);
    expect(t.shouldWaitForMergeChecks({
      repoKey: REPO, prNumber: 7, headSha: SHA, now: now + NO_CHECKS_GRACE_MS,
    })).toBe(false);
    // #8 has never been asked about — its own window starts now.
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
    // A new push is a new commit, and GitHub gets fresh time to register it.
    expect(t.shouldWaitForMergeChecks({
      repoKey: REPO, prNumber: 7, headSha: "sha-newer", now: now + NO_CHECKS_GRACE_MS,
    })).toBe(true);
  });

  it("does not wait when the parsed workflows cannot fire for this pull request", () => {
    // Positive evidence, not absence: no check is coming, so waiting for one
    // would refuse a merge that will never have anything to report.
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
