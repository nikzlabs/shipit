/**
 * planning#297 — the merged-branch auto-push guard.
 *
 * Reproduces the production shape: PR #1963 merged, GitHub deleted the head
 * branch, a later turn committed, and the debounced auto-push RECREATED the
 * branch — an orphan commit belonging to no pull request, which the user read as
 * "changes are missing from the merged PR".
 */

import { describe, it, expect, vi } from "vitest";
import { evaluateMergedBranchPush, formatMergedPushNotice } from "./merged-push-guard.js";
import type { SessionInfo } from "../../shared/types.js";
import type { PrStatusSummary } from "../../shared/types/github-types.js";

const MERGED_SHA = "025e96090000000000000000000000000000aaaa";
const NEW_HEAD = "0d9a31d10000000000000000000000000000bbbb";

function makeSession(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s1",
    title: "Codex polling loop",
    createdAt: "2026-08-04T00:00:00.000Z",
    lastUsedAt: "2026-08-04T00:00:00.000Z",
    remoteUrl: "https://github.com/o/r.git",
    branch: "shipit/codex-poll",
    mergedAt: "2026-08-04 16:33:40",
    mergedHeadSha: MERGED_SHA,
    ...over,
  };
}

function makePrStatus(over: Partial<PrStatusSummary> = {}): PrStatusSummary {
  return {
    sessionId: "s1",
    prNumber: 1963,
    prUrl: "https://github.com/o/r/pull/1963",
    prTitle: "Codex polling loop",
    prBody: "",
    prState: "merged",
    baseBranch: "main",
    headBranch: "shipit/codex-poll",
    insertions: 1,
    deletions: 0,
    checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0 },
    mergeable: "unknown",
    reviewDecision: "none",
    autoMergeEnabled: false,
    ...over,
  };
}

function makeGit(over: Partial<{ head: string | null; ancestor: boolean }> = {}) {
  return {
    getHeadHash: vi.fn().mockResolvedValue(over.head === undefined ? NEW_HEAD : over.head),
    isAncestor: vi.fn().mockResolvedValue(over.ancestor ?? true),
  };
}

describe("evaluateMergedBranchPush", () => {
  it("blocks the push when the commit is stacked on the merged tip (the incident)", async () => {
    const git = makeGit({ ancestor: true });
    const block = await evaluateMergedBranchPush(makeSession(), () => makePrStatus(), git);
    expect(block).toEqual({ prNumber: 1963, baseBranch: "main", branch: "shipit/codex-poll" });
    expect(git.isAncestor).toHaveBeenCalledWith(MERGED_SHA, NEW_HEAD);
  });

  it("allows the push for a session that never merged (one property read, no git)", async () => {
    const session = makeSession();
    delete session.mergedAt;
    const git = makeGit();
    expect(await evaluateMergedBranchPush(session, () => makePrStatus(), git)).toBeNull();
    expect(git.getHeadHash).not.toHaveBeenCalled();
  });

  it("allows the push once the branch has left the merged tip (rebased for a new PR)", async () => {
    // ShipIt's own agent instructions prescribe exactly this after a merge:
    // rebase onto the fresh base, commit, `gh pr create` again. `mergedAt` is
    // still set here — the docs/202 re-arm that clears it runs AFTER the commit —
    // so the ancestry test is the only thing separating this from an orphan push.
    const block = await evaluateMergedBranchPush(makeSession(), () => makePrStatus(), makeGit({ ancestor: false }));
    expect(block).toBeNull();
  });

  it("fails CLOSED when no mergedHeadSha was recorded (cannot prove the branch moved)", async () => {
    const session = makeSession();
    delete session.mergedHeadSha;
    const git = makeGit();
    expect(await evaluateMergedBranchPush(session, () => makePrStatus(), git)).not.toBeNull();
    expect(git.isAncestor).not.toHaveBeenCalled();
  });

  it("falls back to the previousMergedPr breadcrumb when the live snapshot was re-armed away", async () => {
    const session = makeSession({
      previousMergedPr: { number: 1963, url: "https://github.com/o/r/pull/1963", title: "T", baseBranch: "main" },
    });
    const block = await evaluateMergedBranchPush(session, () => null, makeGit());
    expect(block).toEqual({ prNumber: 1963, baseBranch: "main", branch: "shipit/codex-poll" });
  });

  it("blocks with what it knows when neither the snapshot nor a breadcrumb exists", async () => {
    const block = await evaluateMergedBranchPush(makeSession(), () => null, makeGit());
    expect(block).toEqual({ branch: "shipit/codex-poll" });
  });

  it("fails OPEN on a git error rather than stranding every session's auto-push", async () => {
    const git = {
      getHeadHash: vi.fn().mockRejectedValue(new Error("not a git repository")),
      isAncestor: vi.fn(),
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await evaluateMergedBranchPush(makeSession(), () => makePrStatus(), git)).toBeNull();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("formatMergedPushNotice", () => {
  it("answers what happened, why, and how to ship it", async () => {
    const block = (await evaluateMergedBranchPush(makeSession(), () => makePrStatus(), makeGit()))!;
    const notice = formatMergedPushNotice(block, NEW_HEAD);
    expect(notice).toContain("Not pushed");
    expect(notice).toContain("#1963");
    expect(notice).toContain("merged into main");
    expect(notice).toContain("shipit/codex-poll");
    expect(notice).toContain("0d9a31d"); // the abandoned commit, short form
    expect(notice).toContain("gh pr create");
    expect(notice).toContain("shipit branch reset-to-base");
    // The escape that actually works for a branch that gained commits after the
    // merge — `gh pr create` alone reprints the merged PR, and reset-to-base
    // refuses this shape rather than discarding it.
    expect(notice).toContain("git merge origin/main");
    expect(notice).toContain("refuses (rather than discards)");
  });

  it("degrades gracefully when the PR pointers are unknown", () => {
    const notice = formatMergedPushNotice({}, null);
    expect(notice).toContain("for this session");
    expect(notice).not.toContain("undefined");
  });
});
