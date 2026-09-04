import { describe, it, expect, vi } from "vitest";
import { agentMergePullRequest } from "./github.js";
import { resetMergeAttribution } from "./merge-attribution.js";
import type { GitManager } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";

/**
 * docs/224 — `agentMergePullRequest` backs `gh pr merge` for sandbox sessions
 * with the dangerous-ops grant. The route owns the capability gate; this service
 * owns the guardrails: green checks, no draft, no force, branch protection
 * deferred to GitHub. These tests cover each guardrail branch.
 *
 * docs/287 — the guardrails now come from ONE live read
 * (`services/merge-gate.ts`) rather than `viewPullRequest` + `getCheckStatus`.
 * That is a fix to this path, not only a foundation for the new one: the old
 * helper swallowed its own errors and mapped both "no checks configured" and a
 * failed API read to `"none"`, which this service treated as permission to
 * merge. The fake therefore answers the gate's query, and every assertion below
 * that used to describe a check summary now describes a rollup.
 */

const REMOTE = "https://github.com/o/r.git";
const HEAD_SHA = "sha-head";

function makeGit(): GitManager {
  return {
    getRemotes: vi.fn(async () => [{ name: "origin", url: REMOTE }]),
    addRemote: vi.fn(async () => {}),
  } as unknown as GitManager;
}

/** The gate's own answer. `rollupState: null` means GitHub reports no checks. */
function gate(over: {
  state?: string; isDraft?: boolean; reviewDecision?: string | null;
  headRefOid?: string; rollupCommitOid?: string; rollupState?: string | null;
} = {}) {
  const headRefOid = over.headRefOid ?? HEAD_SHA;
  const rollupState = over.rollupState === undefined ? "SUCCESS" : over.rollupState;
  return {
    data: {
      repository: {
        pullRequest: {
          state: over.state ?? "OPEN",
          isDraft: over.isDraft ?? false,
          reviewDecision: over.reviewDecision ?? null,
          headRefOid,
          commits: {
            nodes: [{
              commit: {
                oid: over.rollupCommitOid ?? headRefOid,
                statusCheckRollup: rollupState === null ? null : { state: rollupState },
              },
            }],
          },
        },
      },
    },
  };
}

function makeGitHub(
  over: Partial<Record<keyof GitHubAuthManager, unknown>> = {},
  gateAnswer: ReturnType<typeof gate> | null = gate(),
): GitHubAuthManager {
  return {
    authenticated: true,
    // Dispatching on the query text rather than answering every GraphQL call
    // the same way: a fake that aliases the gate read with any other query
    // cannot fail a test that wires the wrong one.
    graphqlQuery: vi.fn(async (query: string) => (query.includes("MergeGate") ? gateAnswer : null)),
    // docs/287 — the agent merge goes through the THREE-way attempt, because
    // its durable claim is kept or dropped on the distinction between "GitHub
    // refused" and "we never heard back". `mergePullRequest` (the boolean
    // wrapper) is deliberately absent from this fake: a test that wired the
    // wrong one would otherwise pass.
    mergePullRequestAttempt: vi.fn(async () => ({
      outcome: "merged" as const, message: "Pull request merged", mergeCommitSha: "merge-sha",
    })),
    enableAutoMerge: vi.fn(async () => ({ success: true, message: "Auto-merge enabled" })),
    ...over,
  } as unknown as GitHubAuthManager;
}

describe("agentMergePullRequest", () => {
  it("merges when checks are green", async () => {
    const github = makeGitHub();
    const res = await agentMergePullRequest(makeGit(), github, { number: 5, sessionId: "s1", remoteUrl: REMOTE });
    expect(res.success).toBe(true);
    // req 16 — pinned to the commit the gate examined.
    expect(github.mergePullRequestAttempt).toHaveBeenCalledWith("o", "r", 5, "merge", HEAD_SHA);
  });

  it("forwards the chosen merge method", async () => {
    const github = makeGitHub();
    await agentMergePullRequest(makeGit(), github, { number: 5, sessionId: "s1", method: "squash", remoteUrl: REMOTE });
    expect(github.mergePullRequestAttempt).toHaveBeenCalledWith("o", "r", 5, "squash", HEAD_SHA);
  });

  it("merges when GitHub reports no checks and no grace window applies", async () => {
    // A caller with no poller supplies no grace, which is the honest answer:
    // there is nothing that can tell "this repository has no CI" from "the
    // workflows have not registered yet".
    const github = makeGitHub({}, gate({ rollupState: null }));
    const res = await agentMergePullRequest(makeGit(), github, { number: 5, sessionId: "s1", remoteUrl: REMOTE });
    expect(res.success).toBe(true);
  });

  it("waits instead of merging when the grace says the checks may still arrive", async () => {
    const github = makeGitHub({}, gate({ rollupState: null }));
    const res = await agentMergePullRequest(makeGit(), github, {
      number: 5, sessionId: "s1", remoteUrl: REMOTE, graceSaysWait: async () => true,
    });
    expect(res.success).toBe(false);
    expect(res.message).toContain("no checks yet");
    expect(github.mergePullRequestAttempt).not.toHaveBeenCalled();
  });

  it("refuses when the read itself fails, instead of reading it as no checks", async () => {
    // The fail-open this replaced: `getCheckStatus()` swallowed its errors and
    // returned `"none"`, and `"none"` was permission to merge.
    const github = makeGitHub({}, null);
    const res = await agentMergePullRequest(makeGit(), github, { number: 5, sessionId: "s1", remoteUrl: REMOTE });
    expect(res.success).toBe(false);
    expect(github.mergePullRequestAttempt).not.toHaveBeenCalled();
  });

  it("refuses a failing check and never calls merge", async () => {
    const github = makeGitHub({}, gate({ rollupState: "FAILURE" }));
    const res = await agentMergePullRequest(makeGit(), github, { number: 5, sessionId: "s1", remoteUrl: REMOTE });
    expect(res.success).toBe(false);
    expect(res.message).toContain("failing");
    expect(github.mergePullRequestAttempt).not.toHaveBeenCalled();
  });

  it("refuses a still-running check without --auto", async () => {
    const github = makeGitHub({}, gate({ rollupState: "PENDING" }));
    const res = await agentMergePullRequest(makeGit(), github, { number: 5, sessionId: "s1", remoteUrl: REMOTE });
    expect(res.success).toBe(false);
    // The sandbox keeps the `--auto` affordance, so its refusal still names it.
    expect(res.message).toContain("--auto");
    expect(github.mergePullRequestAttempt).not.toHaveBeenCalled();
    expect(github.enableAutoMerge).not.toHaveBeenCalled();
  });

  it("enables auto-merge on a pending check with --auto", async () => {
    const github = makeGitHub({}, gate({ rollupState: "PENDING" }));
    const res = await agentMergePullRequest(makeGit(), github, { number: 5, sessionId: "s1", auto: true, remoteUrl: REMOTE });
    expect(res.autoMergeEnabled).toBe(true);
    expect(github.enableAutoMerge).toHaveBeenCalledWith("o", "r", 5, "MERGE");
    expect(github.mergePullRequestAttempt).not.toHaveBeenCalled();
  });

  it("refuses a draft PR", async () => {
    const github = makeGitHub({}, gate({ isDraft: true }));
    const res = await agentMergePullRequest(makeGit(), github, { number: 5, sessionId: "s1", remoteUrl: REMOTE });
    expect(res.success).toBe(false);
    expect(res.message).toContain("draft");
    expect(github.mergePullRequestAttempt).not.toHaveBeenCalled();
  });

  it("reports an already-merged PR as success without re-merging", async () => {
    const github = makeGitHub({}, gate({ state: "MERGED" }));
    const res = await agentMergePullRequest(makeGit(), github, { number: 5, sessionId: "s1", remoteUrl: REMOTE });
    expect(res.success).toBe(true);
    expect(res.message).toContain("already merged");
    expect(github.mergePullRequestAttempt).not.toHaveBeenCalled();
  });

  it("surfaces GitHub's rejection verbatim (branch protection / required review)", async () => {
    const github = makeGitHub({
      mergePullRequestAttempt: vi.fn(async () => ({
        outcome: "refused" as const, message: "At least 1 approving review is required.",
      })),
    });
    const res = await agentMergePullRequest(makeGit(), github, { number: 5, sessionId: "s1", remoteUrl: REMOTE });
    expect(res.success).toBe(false);
    expect(res.message).toBe("At least 1 approving review is required.");
  });

  // docs/287 req 9 — the three outcomes, and what each does to the claim.
  describe("the durable claim", () => {
    it("claims before the merge call, and settles only a witnessed success", async () => {
      const order: string[] = [];
      const github = makeGitHub({
        mergePullRequestAttempt: vi.fn(async () => {
          order.push("merge");
          return { outcome: "merged" as const, message: "Pull request merged", mergeCommitSha: "m" };
        }),
      });
      const res = await agentMergePullRequest(makeGit(), github, {
        number: 5, sessionId: "s1", remoteUrl: REMOTE,
        onClaim: (sha) => { order.push(`claim:${sha}`); return true; },
        onMerged: async () => { order.push("settle"); },
        onRefused: async () => { order.push("refused"); },
        onIndeterminate: async () => { order.push("indeterminate"); },
      });
      expect(res.success).toBe(true);
      // The claim is durable BEFORE the call, because the call can reject after
      // GitHub accepted it — and success is reported only after settlement.
      expect(order).toEqual([`claim:${HEAD_SHA}`, "merge", "settle"]);
    });

    it("refuses to merge at all when the claim cannot be written", async () => {
      const github = makeGitHub();
      const res = await agentMergePullRequest(makeGit(), github, {
        number: 5, sessionId: "s1", remoteUrl: REMOTE, onClaim: () => false,
      });
      expect(res.success).toBe(false);
      expect(github.mergePullRequestAttempt).not.toHaveBeenCalled();
    });

    it("reports an indeterminate attempt without settling it", async () => {
      // The merge MAY have happened. Settling would claim a merge nobody saw;
      // dropping the claim would lose the only evidence there is.
      const calls: string[] = [];
      const github = makeGitHub({
        mergePullRequestAttempt: vi.fn(async () => ({
          outcome: "indeterminate" as const, message: "ShipIt did not hear back from GitHub",
        })),
      });
      const res = await agentMergePullRequest(makeGit(), github, {
        number: 5, sessionId: "s1", remoteUrl: REMOTE,
        onClaim: () => true,
        onMerged: async () => { calls.push("settle"); },
        onRefused: async () => { calls.push("refused"); },
        onIndeterminate: async () => { calls.push("indeterminate"); },
      });
      expect(res.success).toBe(false);
      expect(calls).toEqual(["indeterminate"]);
    });

    it("releases the claim on a definitive refusal", async () => {
      const calls: string[] = [];
      const github = makeGitHub({
        mergePullRequestAttempt: vi.fn(async () => ({
          outcome: "refused" as const, message: "PR is not mergeable",
        })),
      });
      await agentMergePullRequest(makeGit(), github, {
        number: 5, sessionId: "s1", remoteUrl: REMOTE,
        onClaim: () => true,
        onMerged: async () => { calls.push("settle"); },
        onRefused: async () => { calls.push("refused"); },
        onIndeterminate: async () => { calls.push("indeterminate"); },
      });
      expect(calls).toEqual(["refused"]);
    });
  });

  it("throws a 401 ServiceError when GitHub is not authenticated", async () => {
    const github = makeGitHub({ authenticated: false });
    await expect(agentMergePullRequest(makeGit(), github, { number: 5, sessionId: "s1", remoteUrl: REMOTE })).rejects.toMatchObject({ statusCode: 401 });
  });

  // docs/266 req 7 — before this, `gh pr merge` merged silently, so an incident
  // review could not tell it apart from a merge done in GitHub's own web UI.
  describe("the merge record", () => {
    function mergeLines(log: { mock: { calls: unknown[][] } }): string[] {
      return log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("Merged PR #"));
    }

    it("names the session, the PR, the repo and the method", async () => {
      resetMergeAttribution();
      const log = vi.spyOn(console, "log").mockImplementation(() => { /* silence */ });
      try {
        await agentMergePullRequest(makeGit(), makeGitHub(), {
          number: 5, sessionId: "sandbox-1", method: "squash", remoteUrl: REMOTE,
        });
        expect(mergeLines(log)).toEqual([
          "[pr] Merged PR #5 (o/r) for sandbox-1 via gh pr merge (squash)",
        ]);
      } finally {
        log.mockRestore();
      }
    });

    // Arming is not merging (the packet's own constraint): a `--auto` that hands
    // the PR to GitHub must not be recorded as a merge that has happened.
    it("records nothing when --auto only arms auto-merge", async () => {
      resetMergeAttribution();
      const log = vi.spyOn(console, "log").mockImplementation(() => { /* silence */ });
      try {
        await agentMergePullRequest(
          makeGit(),
          makeGitHub({}, gate({ rollupState: "PENDING" })),
          { number: 5, sessionId: "sandbox-1", auto: true, remoteUrl: REMOTE },
        );
        expect(mergeLines(log)).toEqual([]);
      } finally {
        log.mockRestore();
      }
    });

    // An already-merged PR is a no-op report, not a merge this process performed —
    // recording it would attribute someone else's merge to `gh pr merge`.
    it("records nothing for a PR that was already merged", async () => {
      resetMergeAttribution();
      const log = vi.spyOn(console, "log").mockImplementation(() => { /* silence */ });
      try {
        await agentMergePullRequest(
          makeGit(),
          makeGitHub({}, gate({ state: "MERGED" })),
          { number: 5, sessionId: "sandbox-1", remoteUrl: REMOTE },
        );
        expect(mergeLines(log)).toEqual([]);
      } finally {
        log.mockRestore();
      }
    });
  });
});
