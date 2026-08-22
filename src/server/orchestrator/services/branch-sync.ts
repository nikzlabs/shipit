/**
 * Is the session's branch on GitHub the same branch the session actually has?
 *
 * The merge button merges what is on the REMOTE. Every other merge gate answers
 * a question about that remote state — is CI green, is it mergeable, has review
 * approved — and none of them can see the case where the remote state is simply
 * OLD. ShipIt commits after every turn and pushes on a 5s debounce, so a push
 * that never landed leaves the session holding commits GitHub has never seen,
 * with a pull request that looks perfectly mergeable.
 *
 * That is not a hypothetical. `services/auto-push-scheduler.ts` records the
 * 2026-08-14/15 incident in full: a rebased branch had every unforced push
 * rejected for ten hours, and two pull requests then merged at the state of the
 * last successful push — seven and two commits behind. Both merges passed every
 * gate that existed.
 *
 * ## What this module answers, and what it deliberately does not
 *
 * It compares local HEAD with the remote-tracking ref for the SAME branch and
 * classifies the result ({@link BranchSyncState}). Two readings block a merge —
 * `ahead` (the remote is missing the session's commits) and `diverged` (the two
 * histories disagree, and ShipIt never force-pushes on its own). `behind` does
 * not: the remote is then a superset of local work, so the merge ships more than
 * the session has, never less.
 *
 * **Absence is not a verdict.** Every path that cannot answer — no workspace, a
 * clone with no tracking ref, HEAD on a different branch than the pull request's
 * head, an unreachable remote — returns `undefined`, and callers merge. A guard
 * that blocked on "cannot tell" would take the merge button away from any
 * session whose workspace had been reclaimed, which is both common and harmless.
 * The rule is narrow on purpose: block only on a POSITIVE reading that the
 * remote is behind.
 *
 * ## Two readings, one classifier
 *
 * {@link readBranchSync} is local-only (no network) and runs on every poll tick,
 * so the client can disable the button before it is clicked. Its input is the
 * remote-tracking ref, which this clone's own pushes keep current — which is
 * exactly the state a failed push leaves stale in the blocking direction.
 *
 * {@link resolveMergeSync} is the authoritative one, and runs inside the merge
 * request itself. It fetches the single branch first, so a stale tracking ref
 * cannot pass a merge through, and it is what makes the guard hold against a
 * stale browser tab that never received the poll update.
 */

import type { BranchSyncStatus } from "../../shared/types/github-types.js";
import { getErrorMessage } from "../validation.js";

/**
 * The slice of `GitManager` this module needs. Structural so tests can drive the
 * classifier without a repo, and so the two callers (the poller, the merge
 * route) can pass the manager they already hold.
 */
export interface BranchSyncGit {
  currentBranchOrNull(): Promise<string | null>;
  aheadBehind(ref: string): Promise<{ ahead: number; behind: number } | null>;
  fetchBranch(remote: string, branch: string): Promise<void>;
  push(remote?: string, branch?: string): Promise<string>;
}

/** Classify a pair of commit counts. Total order: both zero ⇒ in sync. */
export function classifyBranchSync(counts: { ahead: number; behind: number }): BranchSyncStatus {
  const { ahead, behind } = counts;
  if (ahead > 0 && behind > 0) return { state: "diverged", ahead, behind };
  if (ahead > 0) return { state: "ahead", ahead, behind };
  if (behind > 0) return { state: "behind", ahead, behind };
  return { state: "in-sync", ahead, behind };
}

/**
 * Read the sync state from local refs only — no network, cheap enough for every
 * poll tick.
 *
 * `branch` is the pull request's HEAD branch, and the check is skipped outright
 * when the workspace is not on it. A session sitting on some other branch tells
 * us nothing about whether the PR's branch is current, and answering anyway
 * would compare two unrelated histories and report a confident `diverged`.
 */
export async function readBranchSync(
  git: BranchSyncGit,
  branch: string,
  remote = "origin",
): Promise<BranchSyncStatus | undefined> {
  if (!branch) return undefined;
  try {
    const current = await git.currentBranchOrNull();
    if (current !== branch) return undefined;
    const counts = await git.aheadBehind(`refs/remotes/${remote}/${branch}`);
    return counts ? classifyBranchSync(counts) : undefined;
  } catch {
    // "Cannot tell" — never a verdict. See the module docstring.
    return undefined;
  }
}

/**
 * Read the sync state against the remote's LIVE tip, by fetching the one branch
 * first.
 *
 * A failed fetch falls back to the local reading rather than giving up, and that
 * is safe in the only direction that matters: a stale tracking ref can hide
 * movement on the REMOTE side (which produces `behind`, which never blocks), but
 * it cannot hide this clone's own unpushed commits — those are stale in the
 * `ahead` direction, which is precisely what the fallback still catches.
 */
export async function resolveMergeSync(
  git: BranchSyncGit,
  branch: string,
  remote = "origin",
): Promise<BranchSyncStatus | undefined> {
  try {
    await git.fetchBranch(remote, branch);
  } catch {
    // Unreachable remote, deleted branch, no credentials. Fall through to the
    // local refs — worse information, never wrong in the blocking direction.
  }
  return readBranchSync(git, branch, remote);
}

/** What the merge route should do about the branch's sync state. */
export type MergeSyncVerdict =
  | { action: "proceed" }
  | { action: "hold"; message: string };

/**
 * The merge route's guard: resolve the sync state and decide.
 *
 * `ahead` is handled by PUSHING rather than by refusing outright — the commits
 * belong on that branch, ShipIt would have pushed them itself, and a plain
 * (never forced) push is the whole remedy. But the merge still does not go ahead
 * on the same click: the push moves the head, so every check the other gates
 * just cleared now refers to the previous commit. Merging on the strength of
 * them would trade "merges too little" for "merges unverified", which is not an
 * improvement. So the push lands and the answer is "not yet" — the poller
 * re-reads the new head, and the next click (or an armed auto-merge) merges the
 * work the session actually produced.
 *
 * `diverged` is refused with no attempt to repair it. The two remedies — pull,
 * or force-push — destroy the other side's commits when chosen wrongly, and
 * which one is right is not derivable from git. The same reasoning already
 * governs the auto-push scheduler, whose transcript notice spells the choice out
 * for the user.
 */
export async function guardMergeSync(
  git: BranchSyncGit,
  branch: string,
  remote = "origin",
): Promise<MergeSyncVerdict> {
  const sync = await resolveMergeSync(git, branch, remote);
  if (!sync) return { action: "proceed" };

  if (sync.state === "diverged") {
    return {
      action: "hold",
      message:
        `Not merged — this session's branch has diverged from ${remote}/${branch}`
        + ` (${sync.ahead} local commit${sync.ahead === 1 ? "" : "s"} the remote does not have,`
        + ` ${sync.behind} remote commit${sync.behind === 1 ? "" : "s"} this session does not have).`
        + " Merging now would ship the remote's history, not this session's work."
        + " Reconcile the branch first — `git pull --rebase` if the remote is simply ahead,"
        + " or a force-push if this branch's history was rewritten on purpose.",
    };
  }

  if (sync.state !== "ahead") return { action: "proceed" };

  const commits = `${sync.ahead} commit${sync.ahead === 1 ? "" : "s"}`;
  try {
    await git.push(remote, branch);
  } catch (err) {
    return {
      action: "hold",
      message:
        `Not merged — ${commits} in this session have not reached GitHub, and pushing them just`
        + ` failed: ${getErrorMessage(err)}. Merging now would ship the branch as it stood at the`
        + " last successful push, without that work.",
    };
  }
  return {
    action: "hold",
    message:
      `Pushed ${commits} that had not reached GitHub yet — merging now would have shipped the`
      + " branch without them. The pull request is on the new head; merge again once its checks"
      + " report.",
  };
}
