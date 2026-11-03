// Prevent automatic pushes from recreating a merged branch with work outside a PR.
// This ancestry test can also block fresh work after a non-squash merge.
import type { SessionInfo } from "../../shared/types.js";
import type { PrStatusSummary } from "../../shared/types/github-types.js";

export interface MergedPushGuardGit {
  getHeadHash(): Promise<string | null>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
}

export interface MergedPushBlock {
  prNumber?: number;
  baseBranch?: string;
  branch?: string;
  /**
   * HEAD is the merged head itself, so the work shipped and there is nothing to
   * report. The push stays refused: it could only recreate a deleted branch.
   */
  atMergedHead?: true;
}

export async function evaluateMergedBranchPush(
  session: SessionInfo | undefined,
  getPrStatus: () => PrStatusSummary | null,
  git: MergedPushGuardGit,
): Promise<MergedPushBlock | null> {
  try {
    if (!session?.mergedAt) return null;

    const anchor = session.mergedHeadSha;
    if (anchor) {
      const head = await git.getHeadHash();
      // Before the ancestry test: a commit is its own ancestor.
      if (head === anchor) return { atMergedHead: true };
      if (head && !(await git.isAncestor(anchor, head))) return null;
    }

    // Re-arming clears the live snapshot; retain the previous PR for the notice.
    // A snapshot that is not merged belongs to another PR and must not be named as merged.
    const prStatus = getPrStatus();
    const prNumber = prStatus
      ? (prStatus.prState === "merged" ? prStatus.prNumber : undefined)
      : session.previousMergedPr?.number;
    const baseBranch = prStatus?.baseBranch ?? session.previousMergedPr?.baseBranch;
    return {
      ...(prNumber !== undefined ? { prNumber } : {}),
      ...(baseBranch !== undefined ? { baseBranch } : {}),
      ...(session.branch !== undefined ? { branch: session.branch } : {}),
    };
  } catch (err) {
    console.error("[merged-push-guard] evaluation failed (allowing the push):", err);
    return null;
  }
}

// Notices render as plain text, so Markdown emphasis would appear literally.
export function formatMergedPushNotice(block: MergedPushBlock, commitHash: string | null): string {
  const pr = block.prNumber ? `#${block.prNumber}` : "for this session";
  const into = block.baseBranch ? ` into ${block.baseBranch}` : "";
  const commit = commitHash ? ` (${commitHash.slice(0, 7)})` : "";
  const branch = block.branch ? ` ${block.branch}` : "";
  const base = block.baseBranch ?? "<base>";
  return (
    `Not pushed — pull request ${pr} already merged.\n\n`
    + `Pull request ${pr} merged${into}, so this session's branch${branch} has no open pull `
    + `request — and a merged branch is usually deleted on GitHub. Pushing would recreate it `
    + `carrying a commit that belongs to no pull request: the "my changes are missing from the `
    + `merged PR" failure mode.\n\n`
    + `The commit${commit} is safe in this session's local history. To ship it, bring the branch `
    + `onto the current base and open a new pull request:\n\n`
    + `    git fetch origin && git merge origin/${base}\n`
    + `    gh pr create ...\n\n`
    + `That is an ordinary merge — not a rebase or a hard reset — so it rewrites no published `
    + `history and discards nothing. If instead the branch holds nothing you still need, `
    + `\`shipit branch reset-to-base\` moves it onto the base; it refuses (rather than discards) `
    + `when the branch carries commits of its own.`
  );
}

// The transcript notice never reaches the agent, which then reports the work as shipped.
export function formatMergedPushAgentNotice(block: MergedPushBlock, commitHash: string | null): string {
  const pr = block.prNumber ? ` (#${block.prNumber})` : "";
  const into = block.baseBranch ? ` into ${block.baseBranch}` : "";
  const commit = commitHash ? ` (${commitHash.slice(0, 7)})` : "";
  const branch = block.branch ? ` \`${block.branch}\`` : "";
  const base = block.baseBranch ?? "<base>";
  // The notice is parked, and a rewind before the next turn can remove the commit it names.
  const removed = commitHash ? commitHash.slice(0, 7) : "these commits";
  return (
    `[System] ShipIt did NOT push this branch's latest commit${commit}. This session's pull `
    + `request${pr} was already merged${into}, so the branch${branch} has no open pull request, and `
    + `ShipIt refuses to auto-push a commit stacked on a merged branch. The commit is only in this `
    + `session's local history; the user has a notice about it in the transcript. Do not tell the `
    + `user that this work is shipped or in a pull request. To ship it, merge the base into the `
    + `branch and open a new pull request: \`git fetch origin && git merge origin/${base}\`, then `
    + `\`gh pr create\`. Do not rebase, \`git reset --hard\` or \`git push --force\`. `
    + `\`shipit branch reset-to-base\` refuses this branch because it carries unshipped commits; `
    + `discarding them with its \`--force\` is the user's decision, not yours. If a rewind has `
    + `removed ${removed} from the branch since, this notice no longer applies.`
  );
}
