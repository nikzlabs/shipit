import { lstat } from "node:fs/promises";
import type { GitManager, UnreadableWorkspace } from "../shared/git.js";
import type { SecretFinding } from "../shared/secret-scan.js";
import type { EvictBlockReason } from "./services/evict-blocked-notice.js";

/**
 * Whether a checkout can be deleted without losing work that exists nowhere else.
 *
 * `durable` means every byte worth keeping is on the remote: the working tree was
 * clean or has just been auto-committed, and the branch tip is an ancestor of (or
 * equal to) its tracking ref. Anything else is a refusal to delete, split the way
 * the disk janitor counts it — `blocked-by-dirty` for work that could not be
 * committed, `blocked-by-push` for commits that could not be sent to origin.
 */
export type CheckoutDurability =
  | { state: "durable" }
  | { state: "blocked-by-dirty"; reason: EvictBlockReason }
  | { state: "blocked-by-push"; cause: "detached-head" }
  | { state: "blocked-by-push"; cause: "push-failed"; message: string };

function describeBlock(r: {
  secretFindings: SecretFinding[];
  conflictedFiles: string[];
  rebaseInProgress: boolean;
  unreadable?: UnreadableWorkspace | null;
}): EvictBlockReason {
  if (r.secretFindings.length > 0) return { kind: "secret", findings: r.secretFindings };
  if (r.conflictedFiles.length > 0 || r.rebaseInProgress) {
    return { kind: "conflict", conflictedFiles: r.conflictedFiles, rebaseInProgress: r.rebaseInProgress };
  }
  if (r.unreadable) return { kind: "unreadable", unreadable: r.unreadable };
  return { kind: "unknown" };
}

// Use the tracking ref: merged branches may be deleted remotely after a successful push.
async function tipIsOnOrigin(git: GitManager, branch: string): Promise<boolean> {
  const head = await git.getHeadHash();
  if (!head) return true;
  const remoteTip = await git.getRefHash(`refs/remotes/origin/${branch}`);
  if (!remoteTip) return false;
  return remoteTip === head || await git.isAncestor(head, remoteTip);
}

// Permission/I/O failures are not absence; a broken .git symlink still needs protection.
export async function pathState(p: string): Promise<"present" | "absent" | "unknown"> {
  try {
    await lstat(p);
    return "present";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unknown";
  }
}

async function ensureBranchTipOnOrigin(git: GitManager): Promise<CheckoutDurability> {
  // Check the actual branch, even on a clean tree: an earlier push may have failed.
  const branch = await git.currentBranchOrNull();
  if (!branch) return { state: "blocked-by-push", cause: "detached-head" };

  if (!(await tipIsOnOrigin(git, branch))) {
    try {
      await git.push("origin", branch);
    } catch (pushErr) {
      return {
        state: "blocked-by-push",
        cause: "push-failed",
        message: pushErr instanceof Error ? pushErr.message : String(pushErr),
      };
    }
  }
  return { state: "durable" };
}

/**
 * Make a checkout safe to delete — commit what is uncommitted, push what is unpushed
 * — and report whether that succeeded.
 *
 * Every caller that deletes a session's checkout must clear this first. The disk
 * janitor's eviction pass and user-initiated archiving are two paths to the same
 * irreversible act, and a second implementation of this rule would drift silently
 * into data loss. Errors are left to the caller: git failing to answer at all is a
 * different situation from git answering "not durable".
 */
export async function ensureCheckoutDurable(
  git: GitManager,
  commitMessage: string,
): Promise<CheckoutDurability> {
  // A null commit can mean refusal. Recheck work, including paths git cannot read.
  const before = await git.inspectWorkingTree();
  if (!before.clean) {
    const { secretFindings, conflictedFiles, rebaseInProgress, unreadable } =
      await git.autoCommit(commitMessage);
    const after = await git.inspectWorkingTree();
    if (!after.clean || after.unreadable || unreadable) {
      return {
        state: "blocked-by-dirty",
        reason: describeBlock({
          secretFindings, conflictedFiles, rebaseInProgress,
          unreadable: unreadable ?? after.unreadable,
        }),
      };
    }
  } else if (before.unreadable) {
    return {
      state: "blocked-by-dirty",
      reason: { kind: "unreadable", unreadable: before.unreadable },
    };
  }

  // A clean working tree can still have uncommitted merge/rebase state inside .git.
  const rebasing = await git.isRebaseInProgress();
  if (rebasing || await git.isMergeOrSequencerInProgress()) {
    return {
      state: "blocked-by-dirty",
      reason: { kind: "conflict", conflictedFiles: [], rebaseInProgress: rebasing },
    };
  }

  return await ensureBranchTipOnOrigin(git);
}
