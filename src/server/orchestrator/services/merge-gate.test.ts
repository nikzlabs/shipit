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

type LocalHead = { kind: "sandbox" } | { kind: "head"; sha: string } | { kind: "unreadable"; reason: string };

async function decide(observation: MergeObservation, over: { localHead?: LocalHead; graceSaysWait?: () => Promise<boolean>; arming?: boolean } = {}) {
  return decideMerge({
    observation,
    prNumber: 7,
    localHead: over.localHead ?? { kind: "sandbox" },
    graceSaysWait: over.graceSaysWait ?? NO_GRACE,
    ...(over.arming ? { arming: true } : {}),
  });
}

const LOCAL: LocalHead = { kind: "head", sha: "sha-head" };

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
    const decision = await decide(observed(), { localHead: { kind: "head", sha: "sha-local" } });
    expect(decision).toMatchObject({ action: "refuse", reason: "local-head-differs" });
  });

  it("does not apply the local-head check when there is no local head (sandbox)", async () => {
    await expect(decide(observed(), { localHead: { kind: "sandbox" } })).resolves.toEqual({ action: "merge", sha: "sha-head" });
  });

  it("refuses when the workspace's own commit could not be read (req 14)", async () => {
    // The case that used to share `null` with the sandbox exemption above, and
    // therefore merged with no local comparison at all: a repo-bound workspace
    // that is evicted, broken, or unreadable has NOT passed req 14's check
    // (cross-agent review finding). The two are distinct values now, so this
    // cannot regress into the exemption by accident.
    const decision = await decide(observed(), {
      localHead: { kind: "unreadable", reason: "not a git repository" },
    });
    expect(decision).toMatchObject({ action: "refuse", reason: "local-head-unreadable" });
    expect(decision.action === "refuse" && decision.message).toContain("not a git repository");
  });

  it("reports an already-merged pull request as merged, not as a refusal", async () => {
    await expect(decide(observed({ prState: "MERGED" }))).resolves.toEqual({ action: "already-merged" });
  });

  it("reports already-merged even when the head has moved since", async () => {
    // The merge already happened; a moved head cannot change that, and saying
    // "push and merge again" to someone whose work shipped is just wrong.
    const decision = await decide(
      observed({ prState: "MERGED", headRefOid: "sha-new", rollupCommitOid: "sha-old" }),
      { localHead: { kind: "head", sha: "sha-local" } },
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

  it("refuses a review decision it does not recognise, rather than merging", async () => {
    // The same rule as the rollup above, and it was missing here: naming the two
    // refusals GitHub documents today lets a value it adds tomorrow fall through
    // to a merge — the one direction this gate must never fail in (cross-agent
    // review finding). Only APPROVED and null permit a merge.
    const decision = await decide(observed({ reviewDecision: "SOMETHING_NEW" }));
    expect(decision).toMatchObject({ action: "refuse", reason: "review-required" });
    expect(decision.action === "refuse" && decision.message).toContain("SOMETHING_NEW");
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

/**
 * docs/288 — the same table, one extra verdict. What must NOT change is the
 * order: an arming still refuses on everything a merge refuses on, so a request
 * is never recorded and then cancelled a tick later by the executor's own table.
 */
describe("decideMerge — arming (docs/288)", () => {
  it("arms rather than merging when the checks are already green", async () => {
    // `--auto` never merges inline. One flag, one meaning: an agent that wants
    // the merge now calls `gh pr merge` without it.
    expect(await decide(observed(), { localHead: LOCAL, arming: true }))
      .toEqual({ action: "arm", sha: "sha-head" });
  });

  it("arms on running checks, which is the case the feature exists for", async () => {
    expect(await decide(observed({ rollupState: "PENDING" }), { localHead: LOCAL, arming: true }))
      .toEqual({ action: "arm", sha: "sha-head" });
  });

  it("arms while the zero-check grace is still open", async () => {
    // The command must not wait, but the request is exactly a thing that waits.
    expect(await decide(
      observed({ rollupState: null }),
      { localHead: LOCAL, arming: true, graceSaysWait: async () => true },
    )).toEqual({ action: "arm", sha: "sha-head" });
  });

  it("arms at the new head when the rollup still describes the old one", async () => {
    // The ordinary shape right after the flush and push: CI has not started on
    // the new commit. Refusing here would refuse the exact case `--auto` is for.
    expect(await decide(
      observed({ headRefOid: "sha-new", rollupCommitOid: "sha-old", rollupState: "SUCCESS" }),
      { localHead: { kind: "head", sha: "sha-new" }, arming: true },
    )).toEqual({ action: "arm", sha: "sha-new" });
  });

  it("does not read a lagging rollup's FAILURE as the armed commit's", async () => {
    // A failure on the commit the push replaced says nothing about the new one,
    // and reading it would refuse the request that push was made to arm.
    expect(await decide(
      observed({ headRefOid: "sha-new", rollupCommitOid: "sha-old", rollupState: "FAILURE" }),
      { localHead: { kind: "head", sha: "sha-new" }, arming: true },
    )).toEqual({ action: "arm", sha: "sha-new" });
  });

  it.each([
    ["a draft", observed({ isDraft: true }), "draft"],
    ["failing checks on the armed commit", observed({ rollupState: "FAILURE" }), "checks-failing"],
    ["a required review", observed({ reviewDecision: "REVIEW_REQUIRED" }), "review-required"],
    ["a closed pull request", observed({ prState: "CLOSED" }), "not-open"],
    ["an unreadable read", { kind: "unreadable", reason: "no answer" } as MergeObservation, "unreadable"],
  ])("still refuses arming for %s", async (_name, observation, reason) => {
    const decision = await decide(observation, { localHead: LOCAL, arming: true });
    expect(decision).toMatchObject({ action: "refuse", reason });
  });

  it("still requires the pull request head to be this workspace's commit", async () => {
    // req 14 is not waived by arming: binding a request to a commit this session
    // is not on would ask ShipIt to merge somebody else's push.
    expect(await decide(observed(), { localHead: { kind: "head", sha: "sha-other" }, arming: true }))
      .toMatchObject({ action: "refuse", reason: "local-head-differs" });
  });

  it("reports an already-merged pull request as merged, not as armable", async () => {
    expect(await decide(observed({ prState: "MERGED" }), { localHead: LOCAL, arming: true }))
      .toEqual({ action: "already-merged" });
  });
});
