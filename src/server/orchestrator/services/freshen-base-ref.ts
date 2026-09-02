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
 * **Fail-safe.** A fetch failure (offline, bad credentials, evicted workspace)
 * returns false, and the caller must then decline to decide rather than decide
 * off a ref it knows may be stale. Both callers treat that as "not progressed",
 * which is the direction that cannot invent a duplicate pull request.
 */
export async function freshenBaseRef(git: GitManager, context: string): Promise<boolean> {
  try {
    await git.fetch("origin");
    return true;
  } catch (err) {
    console.warn(
      `[base-ref] fetch failed for ${context} (declining to decide off a possibly-stale origin/<base>):`,
      err,
    );
    return false;
  }
}
