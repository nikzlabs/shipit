import { describe, it, expect, vi } from "vitest";
import { decideMerge, readMergeObservation, mergeFlushRefusal, type MergeObservation } from "./merge-gate.js";
import type { GitHubAuthManager } from "../github-auth.js";

/**
 * docs/287-agent-merge-per-repo §3 — the observation table. Every row, in both
 * modes, because requirement 7 says the guardrails apply to EVERY agent merge:
 * this read replaced `getCheckStatus()` on the sandbox path too, where mapping a
 * swallowed API failure to `"none"` and merging on it is a live fail-open.
 */

function manager(result: unknown): Pick<GitHubAuthManager, "graphqlQuery"> {
  return { graphqlQuery: vi.fn(async () => result) } as unknown as Pick<GitHubAuthManager, "graphqlQuery">;
}

function prNode(over: Record<string, unknown> = {}, rollup: string | null = "SUCCESS", commitOid = "sha-head") {
  return {
    data: {
      repository: {
        pullRequest: {
          state: "OPEN",
          isDraft: false,
          reviewDecision: null,
          headRefOid: "sha-head",
          commits: {
            nodes: [{ commit: { oid: commitOid, statusCheckRollup: rollup === null ? null : { state: rollup } } }],
          },
          ...over,
        },
      },
    },
  };
}

/** A clean observation the individual tests mutate one field of. */
function observed(over: Partial<Extract<MergeObservation, { kind: "read" }>> = {}): MergeObservation {
  return {
    kind: "read",
    prState: "OPEN",
    isDraft: false,
    reviewDecision: null,
    headRefOid: "sha-head",
    rollupCommitOid: "sha-head",
    rollupState: "SUCCESS",
    ...over,
  };
}

const NO_GRACE = async () => false;

async function decide(observation: MergeObservation, over: { localHead?: string | null; graceSaysWait?: () => Promise<boolean> } = {}) {
  return decideMerge({
    observation,
    prNumber: 7,
    localHead: over.localHead ?? null,
    graceSaysWait: over.graceSaysWait ?? NO_GRACE,
  });
}

describe("readMergeObservation", () => {
  it("reads state, draft, review, both SHAs and the rollup in one round trip", async () => {
    const gh = manager(prNode({ isDraft: true, reviewDecision: "APPROVED" }, "PENDING", "sha-head"));
    await expect(readMergeObservation(gh, "o", "r", 7)).resolves.toEqual({
      kind: "read",
      prState: "OPEN",
      isDraft: true,
      reviewDecision: "APPROVED",
      headRefOid: "sha-head",
      rollupCommitOid: "sha-head",
      rollupState: "PENDING",
    });
  });

  it("is unreadable when the response carries GraphQL errors, even with data", async () => {
    // The dangerous shape: a partial response with `errors` AND a null rollup.
    // `graphqlQuery` logs non-rate-limit errors and returns the body anyway, so
    // without this check that reads as "this repository has no CI" and merges.
    const gh = manager({ ...prNode({}, null), errors: [{ message: "Something went wrong" }] });
    const obs = await readMergeObservation(gh, "o", "r", 7);
    expect(obs.kind).toBe("unreadable");
  });

  it("is unreadable when the query returns null (auth, non-2xx, rate limit)", async () => {
    const obs = await readMergeObservation(manager(null), "o", "r", 7);
    expect(obs.kind).toBe("unreadable");
  });

  it("is unreadable when the pull request, its head, or its commits are missing", async () => {
    await expect(readMergeObservation(manager({ data: { repository: { pullRequest: null } } }), "o", "r", 7))
      .resolves.toMatchObject({ kind: "unreadable" });
    await expect(readMergeObservation(manager(prNode({ headRefOid: undefined })), "o", "r", 7))
      .resolves.toMatchObject({ kind: "unreadable" });
    await expect(readMergeObservation(manager(prNode({ commits: { nodes: [] } })), "o", "r", 7))
      .resolves.toMatchObject({ kind: "unreadable" });
  });

  it("treats a thrown query as unreadable rather than propagating", async () => {
    const gh = { graphqlQuery: vi.fn(async () => { throw new Error("socket hang up"); }) } as unknown as Pick<GitHubAuthManager, "graphqlQuery">;
    await expect(readMergeObservation(gh, "o", "r", 7)).resolves.toMatchObject({ kind: "unreadable" });
  });

  it("reads an absent rollup and an explicit null rollup the same way", async () => {
    const explicit = await readMergeObservation(manager(prNode({}, null)), "o", "r", 7);
    expect(explicit).toMatchObject({ rollupState: null });
  });
});

describe("decideMerge — the observation table", () => {
  it("merges when the checks passed on the head", async () => {
    await expect(decide(observed())).resolves.toEqual({ action: "merge", sha: "sha-head" });
  });

  it("refuses an unreadable answer before examining anything else", async () => {
    const decision = await decide({ kind: "unreadable", reason: "rate limited" });
    expect(decision).toMatchObject({ action: "refuse", reason: "unreadable" });
  });

  it("refuses when the checks describe an older commit than the head (req 16)", async () => {
    // The branch moved after CI started. Merging on those checks merges code CI
    // never saw — and this is checked BEFORE the state checks, so a stale answer
    // is never reported as a CI failure.
    const decision = await decide(observed({ rollupCommitOid: "sha-older", rollupState: "SUCCESS" }));
    expect(decision).toMatchObject({ action: "refuse", reason: "head-moved-since-checks" });
  });

  it("refuses when the pull request head is not this workspace's commit (req 14)", async () => {
    const decision = await decide(observed(), { localHead: "sha-local" });
    expect(decision).toMatchObject({ action: "refuse", reason: "local-head-differs" });
  });

  it("does not apply the local-head check when there is no local head (sandbox)", async () => {
    await expect(decide(observed(), { localHead: null })).resolves.toEqual({ action: "merge", sha: "sha-head" });
  });

  it("reports an already-merged pull request as merged, not as a refusal", async () => {
    await expect(decide(observed({ prState: "MERGED" }))).resolves.toEqual({ action: "already-merged" });
  });

  it("reports already-merged even when the head has moved since", async () => {
    // The merge already happened; a moved head cannot change that, and saying
    // "push and merge again" to someone whose work shipped is just wrong.
    const decision = await decide(
      observed({ prState: "MERGED", headRefOid: "sha-new", rollupCommitOid: "sha-old" }),
      { localHead: "sha-local" },
    );
    expect(decision).toEqual({ action: "already-merged" });
  });

  it("refuses a closed pull request and a draft", async () => {
    await expect(decide(observed({ prState: "CLOSED" }))).resolves.toMatchObject({ reason: "not-open" });
    await expect(decide(observed({ isDraft: true }))).resolves.toMatchObject({ reason: "draft" });
  });

  it.each([["FAILURE"], ["ERROR"]])("refuses a %s rollup — any reported check, required or not (req 7)", async (state) => {
    await expect(decide(observed({ rollupState: state }))).resolves.toMatchObject({ reason: "checks-failing" });
  });

  it("refuses a rollup state it does not recognise, rather than merging", async () => {
    // An unknown value is not permission. GitHub can add states.
    await expect(decide(observed({ rollupState: "SOMETHING_NEW" }))).resolves.toMatchObject({
      action: "refuse", reason: "checks-failing",
    });
  });

  it.each([["REVIEW_REQUIRED"], ["CHANGES_REQUESTED"]])("refuses %s (req 8)", async (decision) => {
    await expect(decide(observed({ reviewDecision: decision }))).resolves.toMatchObject({
      reason: "review-required",
    });
  });

  it("merges when review is APPROVED or not configured", async () => {
    await expect(decide(observed({ reviewDecision: "APPROVED" }))).resolves.toMatchObject({ action: "merge" });
    await expect(decide(observed({ reviewDecision: null }))).resolves.toMatchObject({ action: "merge" });
  });

  it.each([["PENDING"], ["EXPECTED"]])("refuses a %s rollup without waiting (req 17)", async (state) => {
    await expect(decide(observed({ rollupState: state }))).resolves.toMatchObject({ reason: "checks-pending" });
  });

  it("refuses zero checks while the grace says wait", async () => {
    const decision = await decide(observed({ rollupState: null }), { graceSaysWait: async () => true });
    expect(decision).toMatchObject({ action: "refuse", reason: "awaiting-checks" });
  });

  it("merges zero checks once the grace has expired", async () => {
    const decision = await decide(observed({ rollupState: null }), { graceSaysWait: async () => false });
    expect(decision).toEqual({ action: "merge", sha: "sha-head" });
  });

  it("does not consult the grace when checks reported", async () => {
    // Consulting it would START a grace window as a side effect of a merge that
    // never needed one.
    const grace = vi.fn(async () => true);
    await decide(observed({ rollupState: "SUCCESS" }), { graceSaysWait: grace });
    expect(grace).not.toHaveBeenCalled();
  });

  it("merges the SHA it examined, not the pull request number", async () => {
    const decision = await decide(observed({ headRefOid: "abc123", rollupCommitOid: "abc123" }));
    expect(decision).toEqual({ action: "merge", sha: "abc123" });
  });
});

describe("mergeFlushRefusal", () => {
  it("says something different, and actionable, for each blocked outcome", () => {
    const messages = (["blocked-secret", "blocked-unreadable", "blocked-conflict", "partial-unreadable"] as const)
      .map((kind) => mergeFlushRefusal({ kind }));
    expect(new Set(messages).size).toBe(4);
    for (const m of messages) expect(m).toContain("Not merged");
  });
});
