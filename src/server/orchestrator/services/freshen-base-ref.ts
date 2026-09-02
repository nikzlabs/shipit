/**
 * `freshenBaseRef` — the fetch that every base-relative decision must do first.
 *
 * Shared by the two callers that ask a question *about `origin/<base>` in the
 * session's own clone*: the merged-session re-arm (`pr-rearm.ts`) and the
 * agent's `gh pr create` (`github.ts`). It lives in its own module so the
 * precondition has ONE implementation and ONE explanation — a second copy is a
 * second place to forget it, which is how the `gh pr create` path went without
 * it for as long as it did.
 */

import type { GitManager } from "../../shared/git.js";

/**
 * Freshen `origin/<base>` before a base-relative decision, returning whether the
 * ref can now be trusted.
 *
 * `origin/<base>` only moves when THIS clone fetches, and nothing on the merge
 * path does: the poller talks to the GitHub API, the post-merge hook prunes
 * volumes, and the post-turn flow only commits and pushes. So when a merged
 * session resumes, `origin/<base>` is typically still the commit the branch
 * forked from — and a stale base silently INVERTS
 * `GitManager.mergedBaseProgress`: `merge-base(origin/<base>, HEAD)` trivially
 * equals that fork point, so clause 1 ("sits on the *current* base") passes for
 * a branch that was never moved, and the two-dot diff is just the branch's own
 * already-merged work. The gate then reports `progressed` for a branch carrying
 * nothing but shipped commits.
 *
 * Two observed symptoms, one cause:
 *
 * - Re-arm: the first committing turn on a merged session un-merged it and left
 *   a gray "ready" card showing the stale full-branch diff plus a "Create PR"
 *   button, while the branch still carried nothing but shipped commits. Worse,
 *   `clearMerged` drops `mergedHeadSha`, so the docs/218 pre-turn auto-advance
 *   could never fire for that session again — the false re-arm *disabled* the
 *   very feature whose absence it looked like.
 * - `gh pr create`: the same false positive opens a genuinely NEW pull request
 *   whose diff is work that already shipped under the merged one.
 *
 * **Fetch the ONE ref, not the remote.** `fetchBranch` uses an explicit forced
 * refspec; a bare `git fetch origin` updates `origin/<base>` only if the clone's
 * configured fetch refspec happens to match, which holds for ShipIt's own clones
 * but not for a repo the user brought themselves (docs/211 Sandbox clones). A
 * broad fetch can therefore *succeed* while leaving the very ref we are about to
 * decide on stale — a true return that means nothing, which is worse than no
 * fetch at all because it looks like diligence.
 *
 * The broad fetch survives only as a FALLBACK, for the case `fetchBranch`
 * refuses: it throws when the branch is absent from the remote (a deleted
 * release branch), and that must not read as "the remote is unreachable". If the
 * broad fetch then succeeds, the remote answered — the caller goes on to the
 * gate, which reports `base-unknown` for a base that really is gone.
 *
 * **Fail-safe.** Both fetches failing (offline, bad credentials, evicted
 * workspace) returns false, and the caller must then decline to decide rather
 * than decide off a ref it knows may be stale. Both callers treat that as "not
 * progressed", the direction that cannot invent a duplicate pull request.
 */
export async function freshenBaseRef(
  git: GitManager,
  baseBranch: string,
  context: string,
): Promise<boolean> {
  try {
    await git.fetchBranch("origin", baseBranch);
    return true;
  } catch (branchErr) {
    try {
      await git.fetch("origin");
      return true;
    } catch (remoteErr) {
      console.warn(
        `[base-ref] could not refresh origin/${baseBranch} for ${context} `
          + `(declining to decide off a possibly-stale ref):`,
        branchErr,
        remoteErr,
      );
      return false;
    }
  }
}
