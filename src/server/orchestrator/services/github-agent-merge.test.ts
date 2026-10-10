import { describe, it, expect, vi } from "vitest";
import { agentMergePullRequest } from "./github.js";
import { resetMergeAttribution } from "./merge-attribution.js";
import type { GitManager } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";

const REMOTE = "https://github.com/o/r.git";
const HEAD_SHA = "sha-head";

function makeGit(): GitManager {
  return {
    getRemotes: vi.fn(async () => [{ name: "origin", url: REMOTE }]),
    addRemote: vi.fn(async () => {}),
  } as unknown as GitManager;
}

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
    graphqlQuery: vi.fn(async (query: string) => (query.includes("MergeGate") ? gateAnswer : null)),
    // Omit the boolean merge wrapper so tests detect losing the indeterminate outcome.
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
    expect(github.mergePullRequestAttempt).toHaveBeenCalledWith("o", "r", 5, "merge", HEAD_SHA);
  });

  it("forwards the chosen merge method", async () => {
    const github = makeGitHub();
    await agentMergePullRequest(makeGit(), github, { number: 5, sessionId: "s1", method: "squash", remoteUrl: REMOTE });
    expect(github.mergePullRequestAttempt).toHaveBeenCalledWith("o", "r", 5, "squash", HEAD_SHA);
  });

  it("merges when GitHub reports no checks and no grace window applies", async () => {
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
    expect(res.retryable).toBe(true);
    expect(github.mergePullRequestAttempt).not.toHaveBeenCalled();
  });

  it("marks only the refusals that clear by themselves as retryable", async () => {
    const answer = async (g: ReturnType<typeof gate>) =>
      (await agentMergePullRequest(makeGit(), makeGitHub({}, g), {
        number: 5, sessionId: "s1", remoteUrl: REMOTE,
      })).retryable;
    expect(await answer(gate({ rollupState: "PENDING" }))).toBe(true);
    expect(await answer(gate({ rollupCommitOid: "sha-older" }))).toBe(true);
    expect(await answer(gate({ rollupState: "FAILURE" }))).toBeUndefined();
    expect(await answer(gate({ isDraft: true }))).toBeUndefined();
    expect(await answer(gate({ reviewDecision: "CHANGES_REQUESTED" }))).toBeUndefined();
    expect(await answer(gate({ state: "CLOSED" }))).toBeUndefined();
  });

  it("refuses when the read itself fails, instead of reading it as no checks", async () => {
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

  it("says what idle means when it records a repo-bound --auto request (docs/288-agent-merge-arming req 8)", async () => {
    const arm = (backgroundWork?: string[]) => agentMergePullRequest(
      makeGit(), makeGitHub({}, gate({ rollupState: "PENDING" })),
      {
        number: 5, sessionId: "s1", auto: true, remoteUrl: REMOTE, repoBound: true,
        localHead: { kind: "head", sha: HEAD_SHA }, onArm: () => null,
        ...(backgroundWork ? { backgroundWork } : {}),
      },
    );

    const quiet = await arm();
    expect(quiet).toMatchObject({ success: true, autoMergeEnabled: true });
    expect(quiet.message).toContain("once its checks pass and this session is idle");
    expect(quiet.message).toContain("no background command");
    expect(quiet.message).not.toContain("is running in this session now");

    const busy = await arm(["npm run dev"]);
    expect(busy.message).toContain('Background work is running in this session now ("npm run dev")');
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
    expect(res.retryable).toBeUndefined();
  });

  it("marks GitHub's refusal for a required check that has not reported yet as retryable", async () => {
    const github = makeGitHub({
      mergePullRequestAttempt: vi.fn(async () => ({
        outcome: "refused" as const, message: 'Required status check "ci" is expected.',
      })),
    });
    const res = await agentMergePullRequest(makeGit(), github, { number: 5, sessionId: "s1", remoteUrl: REMOTE });
    expect(res.success).toBe(false);
    expect(res.message).toBe('Required status check "ci" is expected.');
    expect(res.retryable).toBe(true);
  });

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
        beforeMerge: (sha: string) => { order.push(`claim:${sha}`); return null; },
        onMerged: async () => { order.push("settle"); return "settled" as const; },
        onRefused: async () => { order.push("refused"); },
        onIndeterminate: async () => { order.push("indeterminate"); },
      });
      expect(res.success).toBe(true);
      expect(order).toEqual([`claim:${HEAD_SHA}`, "merge", "settle"]);
    });

    it("refuses to merge at all when the last gate says no, in the gate's own words", async () => {
      const github = makeGitHub();
      const res = await agentMergePullRequest(makeGit(), github, {
        number: 5, sessionId: "s1", remoteUrl: REMOTE,
        beforeMerge: () => "Not merged — the permission was withdrawn.",
      });
      expect(res.success).toBe(false);
      expect(res.message).toBe("Not merged — the permission was withdrawn.");
      expect(github.mergePullRequestAttempt).not.toHaveBeenCalled();
    });

    it("reports an indeterminate attempt without settling it", async () => {
      const calls: string[] = [];
      const github = makeGitHub({
        mergePullRequestAttempt: vi.fn(async () => ({
          outcome: "indeterminate" as const, message: "ShipIt did not hear back from GitHub",
        })),
      });
      const res = await agentMergePullRequest(makeGit(), github, {
        number: 5, sessionId: "s1", remoteUrl: REMOTE,
        beforeMerge: () => null,
        onMerged: async () => { calls.push("settle"); return "settled" as const; },
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
        beforeMerge: () => null,
        onMerged: async () => { calls.push("settle"); return "settled" as const; },
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
