/**
 * planning#297 — refuse the silent post-turn auto-push on a session whose pull
 * request has already merged.
 *
 * ## The failure this exists to stop
 *
 * A session's PR merges. Most repositories delete the head branch on merge, and
 * ShipIt's own post-merge cleanup tries to delete it too. The session stays
 * alive, so a later turn commits and `postTurnCommit` arms the ordinary debounced
 * auto-push — which *creates the branch again* on GitHub, carrying the merged
 * history plus one new commit that belongs to no pull request. Nothing tells the
 * user, and nothing tells the agent. Twice now the user has reported it as
 * "changes are missing from the merged PR"; from the orchestrator log of the
 * incident that produced this guard:
 *
 * ```
 * 16:33:40  Branch cleanup failed for merged session … (remote rejected)
 * 16:33:40  [pr-poller] Post-merge: marked … as merged
 * 16:35:28  [git] Committed: 0d9a31d1…
 * 16:35:35  [git] Pushed to origin/shipit/…      <- recreated the deleted branch
 * 16:35:49  user: "Pr was actually already merged"   <- they worked it out unaided
 * ```
 *
 * ## Blocked, not allowed-with-a-warning
 *
 * The commit always happens — work is never lost, and it stays reflog-recoverable
 * in the session clone. Only the *push* is refused, and only the **silent**
 * debounced one. That distinction is what makes blocking cheap rather than
 * restrictive:
 *
 *   - An explicit `gh pr create` pushes through its OWN path
 *     (`agentCreatePr` / `quickCreatePr`, which force-push), so the user who
 *     genuinely wants to keep shipping from this branch is one command away and
 *     is never blocked by this guard. The same carve-out the ops-session gate
 *     already makes in `postTurnCommit`.
 *   - A session that legitimately continues after a merge has `mergedAt` cleared
 *     before it can matter — by the docs/218 pre-turn reset (which re-arms via
 *     `detectAndReArmResetSession`) or by the docs/202 post-turn re-arm — so
 *     ordinary work resumes pushing with no involvement from this guard.
 *
 * Allowing the push with a loud notice was the alternative, and it loses on the
 * only case that matters: the notice is the thing the user did not read *last*
 * time either, and by the time they do the orphan branch already exists on
 * GitHub. A refusal is reversible in one command; a resurrected branch with a
 * commit nobody reviewed is a support conversation.
 *
 * ## Why the ancestry check earns its keep
 *
 * Gating on `mergedAt` alone would be simpler, but it would false-positive on a
 * flow ShipIt's own agent instructions prescribe: after a merge, "rebase onto the
 * freshly-fetched base … then make your new commits and run `gh pr create`
 * again". A branch rebased onto the fresh base no longer contains the merged tip,
 * its commits are genuinely new, and its push is a legitimate pre-PR push — while
 * `mergedAt` is still set, because the docs/202 re-arm that clears it runs
 * *after* the commit. So the discriminator is whether the branch still carries
 * the merged tip: `mergedHeadSha` (the SHA GitHub actually merged, docs/218) is
 * an ancestor of HEAD ⇒ this commit is stacked on already-shipped history ⇒
 * orphan push. One local `merge-base` call, no network.
 *
 * Fails CLOSED when there is no `mergedHeadSha` to test against (a pre-docs/218
 * merge, or a merge whose REST payload carried no `head.sha`): we cannot prove
 * the branch left the merged tip, and the cost of being wrong in that direction
 * is a notice on a session that still can't lose work.
 *
 * The ancestry test discriminates cleanly only under a SQUASH merge, where the
 * merged head SHA never enters the base. Under a merge-commit or
 * rebase-and-merge strategy it *is* in the base, so a branch rebased onto the
 * fresh base still has it as an ancestor and this guard blocks that push too.
 * Stated rather than fixed: the consequence is a notice that over-warns and a
 * push deferred to the `gh pr create` that flow ends in anyway — no lost commit —
 * and the alternative discriminators (an open-PR lookup at commit time, a
 * containment diff) cost a network round-trip in the post-turn path to buy back
 * a case ShipIt's own repo does not have.
 */

import type { SessionInfo } from "../../shared/types.js";
import type { PrStatusSummary } from "../../shared/types/github-types.js";

/** The two local git reads the guard needs. Structural so tests can stub it. */
export interface MergedPushGuardGit {
  getHeadHash(): Promise<string | null>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
}

/** Returned when the push must not land; carries what the notice needs to say. */
export interface MergedPushBlock {
  prNumber?: number;
  baseBranch?: string;
  branch?: string;
}

/**
 * Decide whether this session's post-turn auto-push may land. Returns null when
 * it may (the overwhelming majority — one property read for a non-merged
 * session), or the block info when it must not.
 *
 * Fail-safe in the *allow* direction: an unreadable git state returns null and
 * the push proceeds as it did before this guard existed. The alternative would
 * let one broken git read strand every session's auto-push, which is a worse
 * failure than the narrow one this guards — and `getHeadHash` / `isAncestor`
 * both already swallow their own errors, so this catch is belt-and-braces.
 */
export async function evaluateMergedBranchPush(
  session: SessionInfo | undefined,
  /**
   * Lazy on purpose: the PR snapshot is only needed to WORD the notice, and the
   * non-merged early return below is what runs on every ordinary turn. Passing
   * the value eagerly would make every auto-push in the process pay a lookup it
   * discards.
   */
  getPrStatus: () => PrStatusSummary | null,
  git: MergedPushGuardGit,
): Promise<MergedPushBlock | null> {
  try {
    if (!session?.mergedAt) return null;

    const anchor = session.mergedHeadSha;
    if (anchor) {
      const head = await git.getHeadHash();
      // The branch left the merged tip (rebased / reset onto a fresh base), so
      // whatever is on it now is genuinely new work heading for a new PR. The
      // docs/202 / docs/216 re-arm — which runs right after this, in the same
      // post-turn flow — is what clears `mergedAt` for it.
      if (head && !(await git.isAncestor(anchor, head))) return null;
    }

    // The live snapshot when the poller still holds it, else the durable
    // `previousMergedPr` breadcrumb — `PrStatusPoller.reArm` nulls the snapshot
    // on the ordinary keep-working-after-a-merge path, and a notice that can't
    // name the pull request is most of the notice's value gone.
    const prStatus = getPrStatus();
    const prNumber = prStatus?.prNumber ?? session.previousMergedPr?.number;
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

/**
 * The persisted transcript notice for a refused push. It has to answer the three
 * questions the user asked out loud during the incident, in order: what happened
 * to my commit, why, and how do I ship it.
 *
 * Plain prose, no markdown emphasis: `MessageList` renders a `notice` message as
 * pre-wrapped text (`useMarkdown` is false for notices), so `**bold**` would show
 * up literally. Backticks match what the neighbouring conflict / secret-scan
 * notices already do.
 */
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
    // The old advice named `gh pr create` and `shipit branch reset-to-base` as
    // if either would do. Neither ships a branch that gained commits after the
    // merge while the base moved on: `gh pr create` reprints the merged PR, and
    // reset-to-base REFUSES that shape (clause `head-moved`) rather than
    // discarding it. The ordinary merge below is what actually works.
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
