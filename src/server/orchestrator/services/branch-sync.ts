import type { BranchSyncStatus } from "../../shared/types/github-types.js";
import { getErrorMessage } from "../validation.js";

export interface BranchSyncGit {
  currentBranchOrNull(): Promise<string | null>;
  aheadBehind(ref: string): Promise<{ ahead: number; behind: number } | null>;
  fetchBranch(remote: string, branch: string): Promise<void>;
  push(remote?: string, branch?: string): Promise<string>;
}

export function classifyBranchSync(counts: { ahead: number; behind: number }): BranchSyncStatus {
  const { ahead, behind } = counts;
  if (ahead > 0 && behind > 0) return { state: "diverged", ahead, behind };
  if (ahead > 0) return { state: "ahead", ahead, behind };
  if (behind > 0) return { state: "behind", ahead, behind };
  return { state: "in-sync", ahead, behind };
}

// Poll from local refs. An unknown result does not block merging.
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
    return undefined;
  }
}

/**
 * `requireFetch` — answer `undefined` rather than reading stale refs when the
 * fetch fails. Only the unattended auto-merge asks for it: a fetch failure is
 * silent, so the fallback reading below is indistinguishable from a verified
 * one, and "in-sync" against a tracking ref that predates the outage reads as
 * permission to merge. A user-initiated merge keeps the fallback — it still
 * catches `ahead` from local refs, and a person is there to see the result.
 */
export async function resolveMergeSync(
  git: BranchSyncGit,
  branch: string,
  remote = "origin",
  opts: { requireFetch?: boolean } = {},
): Promise<BranchSyncStatus | undefined> {
  try {
    await git.fetchBranch(remote, branch);
  } catch {
    // Fall back to local refs when the remote cannot be read.
    if (opts.requireFetch) return undefined;
  }
  return readBranchSync(git, branch, remote);
}

// Cancel a pending auto-push only when `pushed` confirms its replacement landed.
export type MergeSyncVerdict =
  | { action: "proceed" }
  | { action: "hold"; pushed: boolean; message: string };

export async function guardMergeSync(
  git: BranchSyncGit,
  remote = "origin",
): Promise<MergeSyncVerdict> {
  // Match the merge route's current branch, which may differ from the PR card.
  const branch = await git.currentBranchOrNull().catch(() => null);
  if (!branch) return { action: "proceed" };

  const sync = await resolveMergeSync(git, branch, remote);
  if (!sync) return { action: "proceed" };

  if (sync.state === "diverged") {
    return {
      action: "hold",
      pushed: false,
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
      pushed: false,
      message:
        `Not merged — ${commits} in this session have not reached GitHub, and pushing them just`
        + ` failed: ${getErrorMessage(err)}. Merging now would ship the branch as it stood at the`
        + " last successful push, without that work.",
    };
  }
  // The push changed HEAD; wait for checks on that commit before merging.
  return {
    action: "hold",
    pushed: true,
    message:
      `Pushed ${commits} that had not reached GitHub yet — merging now would have shipped the`
      + " branch without them. The pull request is on the new head; merge again once its checks"
      + " report.",
  };
}
