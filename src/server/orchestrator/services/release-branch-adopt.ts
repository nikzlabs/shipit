/**
 * docs/214 — adopt the release head branch onto a session after `shipit release
 * prepare` opens the version-bump PR.
 *
 * The release-branch mechanism opens the bump PR with head `release/<version>`
 * and base the maintenance branch (`stable`). That head is NOT the session's
 * tracked `session.branch` (e.g. `shipit/xxxxx`). The PR status poller matches
 * PRs to sessions **by `session.branch`** (`pr-status-poller.ts` `pollRepo`), so
 * without this the inline PR lifecycle card — the one carrying the merge button,
 * the only in-ShipIt path to *merge* the release PR — never appears for it, and
 * the user is forced out to a GitHub tab. That violates CLAUDE.md §1/§2 (review +
 * merge happen inside ShipIt, never by bouncing to an upstream tab).
 *
 * The fix repoints `session.branch` to the release head branch so all the
 * existing PR-card + merge plumbing discovers and drives the release PR with
 * **zero new surfacing path**: the merge button the user already knows merges the
 * bump PR, which is exactly the human-act gate the release-branch mechanism
 * wants. The release-status-poller's own card (which narrates the
 * pr_open → pr_merged → published lifecycle) is unchanged and coexists — it
 * reports the release *outcome*; the PR card provides the merge *action*.
 *
 * Factored into a testable helper (mirroring `pr-rearm.ts`) so it can be covered
 * without standing up the full release route.
 */

import type { SessionManager } from "../sessions.js";
import type { PrStatusPoller } from "../pr-status-poller.js";

export interface AdoptReleaseBranchDeps {
  sessionManager: SessionManager;
  /** Optional — absent in degraded/test setups; then we only repoint + rebroadcast. */
  prStatusPoller?: PrStatusPoller;
  sseBroadcast: (event: string, data: unknown) => void;
}

/**
 * Repoint a session onto the `release/<version>` head branch the release PR was
 * opened from, and re-arm the PR poller so the inline PR lifecycle card
 * discovers + broadcasts that PR.
 *
 * Returns true when the session was repointed; false (no-op) when the session is
 * gone or already tracks the release branch (a `prepare` re-run for the same
 * version — the poller is already armed for it, so nothing to do).
 *
 * The caller is responsible for only invoking this when the release targeted the
 * session's OWN repo (not a sandbox `--repo` clone), since the poller polls the
 * session's remote.
 */
export async function adoptReleaseBranch(args: {
  deps: AdoptReleaseBranchDeps;
  sessionId: string;
  releaseHeadBranch: string;
}): Promise<boolean> {
  const { deps, sessionId, releaseHeadBranch } = args;
  const session = deps.sessionManager.get(sessionId);
  if (!session) return false;
  if (session.branch === releaseHeadBranch) return false; // re-run — already adopted

  // Repoint the tracked branch to the release PR's head so the PR poller (which
  // matches PRs to sessions by `session.branch`) can find the release PR.
  deps.sessionManager.setBranch(sessionId, releaseHeadBranch);

  if (deps.prStatusPoller) {
    // `reArm` clears the prior branch's stale PR snapshot (in-memory + persisted)
    // and re-tracks the session by its remote — without it the poller would keep
    // broadcasting the session's previous (now-irrelevant) PR. `forceRefresh`
    // then discovers the release PR by its new head now, rather than waiting for
    // the next background tick.
    deps.prStatusPoller.reArm(sessionId);
    await deps.prStatusPoller.forceRefreshSession(sessionId);
  }

  // The sidebar regroups from the session list over SSE only, so rebroadcast it
  // to reflect the branch change without a reload.
  deps.sseBroadcast("session_list", { sessions: deps.sessionManager.list() });
  return true;
}
