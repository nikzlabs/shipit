/**
 * docs/287-agent-merge-per-repo §4 — settling an agent merge, and recovering one
 * whose outcome was never learned.
 *
 * ## What settlement is
 *
 * A merge that GitHub performed is not finished until the session says so:
 * `merged_at`, the merged snapshot, `mergedHeadSha` and reset eligibility all
 * have to land, or the agent's very next step — `shipit branch reset-to-base` —
 * reads `not-merged` for work that shipped. Settlement runs the ONE canonical
 * terminal promotion (`PrStatusPoller.promoteMergedPrByNumber`), writes the
 * transcript record, and only then drops the claim.
 *
 * ## What recovery may claim
 *
 * A witnessed REST success records *"the agent merged it"*. Recovery that merely
 * finds `expected_sha` merged records something narrower — *"the agent asked for
 * this commit, and it is now merged"* — because a user, the pull-request card,
 * or GitHub's own auto-merge could have landed the same commit in the meantime,
 * and `merge-attribution.ts` documents that this race cannot honestly name the
 * performer.
 *
 * ## What reconciliation must not do
 *
 * It must not race the turn a claim belongs to. Reattachment re-establishes
 * ownership and returns while the adopted turn keeps running, still editing and
 * still pushing — settling behind its back would mark the session merged and
 * delete its remote branch mid-turn. So a session with an active turn is skipped
 * and picked up at the end of that turn.
 */

import type { SessionManager } from "../sessions.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { ChatHistoryManager } from "../chat-history.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { AgentMergeClaim, AgentMergeClaimStore } from "../agent-merge-claims.js";
import { currentTurnId, mergeRecordId } from "../agent-merge-claims.js";
import { persistNoticeUnattached } from "../chat-card-persistence.js";
import { ownerRepoFromRepoId, repoId } from "../git-utils.js";

export interface AgentMergeSettlementDeps {
  claims: AgentMergeClaimStore;
  sessionManager: SessionManager;
  chatHistoryManager: ChatHistoryManager;
  prStatusPoller?: PrStatusPoller;
  runnerRegistry?: SessionRunnerRegistry;
}

/** Why a settlement attempt ended, for the caller and for the tests. */
export type SettlementOutcome =
  /** Promoted and recorded; the claim is gone. */
  | { result: "settled"; merged: true }
  /** The pull request is not merged after all — the claim is gone, nothing recorded. */
  | { result: "not-merged" }
  /** GitHub did not answer, or the session moved on. The claim stays. */
  | { result: "deferred"; reason: string };

/**
 * Does this session still own the claim's pull request?
 *
 * Both halves are required. `remoteUrl` is rewritten in place when `origin`
 * changes and pull-request numbers coincide across repositories, so a number
 * alone could point the promotion at a different repository's pull request of
 * the same number. When either has moved on, the merge is real but this session
 * is no longer the place to record it.
 */
function sessionStillOwns(deps: AgentMergeSettlementDeps, claim: AgentMergeClaim): boolean {
  const session = deps.sessionManager.get(claim.sessionId);
  if (!session) return false;
  if (session.prNumber !== claim.prNumber) return false;
  if (session.prRepoId !== claim.repoId) return false;
  return repoId(session.remoteUrl ?? "") === claim.repoId;
}

/**
 * The pair the GitHub API takes, from the CLAIM's own repository identity.
 *
 * Derived from the claim rather than from the session's current `remoteUrl`,
 * which is what a repointed session would answer. Everything asked about a claim
 * has to be asked of the repository the merge was attempted in — that is the
 * whole point of resolving a claim from its own tuple.
 */
function ownerRepoFor(claim: AgentMergeClaim): { owner: string; repo: string } | null {
  return ownerRepoFromRepoId(claim.repoId);
}

/**
 * Settle one claim: promote the pull request, record the merge, release the row.
 *
 * `witnessed` distinguishes the two things the record may say. Pass true only
 * when THIS process saw a merge response come back.
 */
export async function settleAgentMerge(
  deps: AgentMergeSettlementDeps,
  claim: AgentMergeClaim,
  opts: {
    witnessed: boolean;
    /**
     * Re-asked immediately before the promotion, which is the first thing that
     * writes. A caller that awaited I/O to get here cannot rely on a check it
     * made before that await.
     */
    stillSafeToSettle?: () => boolean;
  },
): Promise<SettlementOutcome> {
  // Settlement operates on the ROW, not on the object handed in: the caller's
  // copy can be stale, and re-promoting a claim that has already been settled
  // would re-run the once-per-merge effects for nothing.
  const live = deps.claims.get(claim.sessionId);
  if (live?.expectedSha !== claim.expectedSha) {
    return { result: "deferred", reason: "the claim has already been resolved" };
  }
  if (!deps.prStatusPoller) return { result: "deferred", reason: "no pull-request poller" };
  const target = ownerRepoFor(claim);
  if (!target) return { result: "deferred", reason: "the claim has no readable repository" };

  // The tuple guard runs BEFORE the promotion, not after: the promotion is what
  // writes session state, so checking afterwards would already have written it.
  if (!sessionStillOwns(deps, claim)) {
    return settleWithoutSession(deps, claim, target);
  }

  // docs/287 req 9 — the turn that owns this claim must still be the one
  // running, for a settlement that runs INSIDE a turn. Recorded at claim time
  // and compared here rather than merely stored: the merge and the settlement
  // are separated by a GitHub round trip, and a turn that ended in between no
  // longer owns the session state this is about to write. Reconciliation, which
  // runs with no turn at all, is exempt — its own rule is stronger.
  if (opts.witnessed && deps.runnerRegistry) {
    const active = activeTurnIdFor(deps.runnerRegistry, claim.sessionId);
    if (active !== null && active !== claim.turnId) {
      return { result: "deferred", reason: "the turn that claimed this merge has ended" };
    }
  }

  if (opts.stillSafeToSettle && !opts.stillSafeToSettle()) {
    return { result: "deferred", reason: "a turn started on this session" };
  }

  const read = await deps.prStatusPoller.promoteMergedPrByNumber({
    sessionId: claim.sessionId,
    owner: target.owner,
    repo: target.repo,
    prNumber: claim.prNumber,
    // Asked after GitHub answered and before anything is written. Both halves
    // were previously checked on the wrong side of this await: the turn check
    // above it, and the commit check BELOW it — so a promotion could mark the
    // session merged, re-anchor its reset and fire the merge callbacks for a
    // commit the claim never asked about, and only then decide to record
    // nothing (cross-agent review finding).
    guard: (pr) => {
      if (opts.stillSafeToSettle && !opts.stillSafeToSettle()) return false;
      // A witnessed merge is exempt: the REST call pinned `expected_sha`, so
      // GitHub already enforced the match — while `head_sha` can legitimately
      // read differently afterwards on a repository that deletes the branch.
      if (!opts.witnessed && pr.merged_at !== null && pr.head_sha !== claim.expectedSha) return false;
      return true;
    },
  });
  if (!read) return { result: "deferred", reason: "GitHub did not answer" };
  const facts = read.pr;

  if (facts.merged_at === null) {
    // A `settling` row was written because a merge response CAME BACK. GitHub's
    // read-after-write is not instant, so a follow-up GET that still says open
    // is a stale read, not a contradiction — and deleting the row on it would
    // destroy the durable proof of a merge this process witnessed. Only a
    // `merging` row, whose outcome was never learned, may be resolved as
    // not-merged (cross-agent review finding).
    if (live.state === "settling") {
      return { result: "deferred", reason: "the pull request does not read as merged yet" };
    }
    // Resolved from the claim's own tuple, never from the shape of an error:
    // the pull request is still open, so nothing merged and the claim is spent.
    deps.claims.release(claim.sessionId, claim.expectedSha);
    return { result: "not-merged" };
  }

  // It merged — but was it THIS commit? A pull request can be force-pushed and
  // merged at a different head between an indeterminate attempt and this read,
  // and `merged_at` alone cannot tell those apart. Recording the claimed commit
  // as merged when another one was would be a false record. The `guard` above
  // already stopped the promotion; this is the same condition deciding what to
  // do with the row now that nothing has been written.
  if (!opts.witnessed && facts.head_sha !== claim.expectedSha) {
    console.warn(
      `[agent-merge] ${mergeRecordId(claim)} — PR #${claim.prNumber} merged at `
      + `${facts.head_sha ?? "an unknown commit"}, not the claimed commit. Recording nothing.`,
    );
    deps.claims.release(claim.sessionId, claim.expectedSha);
    return { result: "not-merged" };
  }

  // The only remaining reason the guard can have refused: a turn started on the
  // session while GitHub was answering. Nothing was written, and the row stays
  // for the next reconciliation pass.
  if (!read.promoted) return { result: "deferred", reason: "a turn started on this session" };

  const recordId = mergeRecordId(claim);
  const message = opts.witnessed
    ? `Merged pull request #${claim.prNumber} at ${claim.expectedSha.slice(0, 8)}. (${recordId})`
    // Narrower on purpose: a user, the pull-request card, or GitHub's own
    // auto-merge could have landed the same commit while ShipIt was not
    // looking, and nothing here can tell those apart.
    : `The commit this session asked to merge (${claim.expectedSha.slice(0, 8)}) is now merged as `
      + `pull request #${claim.prNumber}. (${recordId})`;

  deps.claims.releaseAfterRecording(claim.sessionId, claim.expectedSha, () => {
    // Unattached by construction: a settlement can run post-turn or after a
    // restart, when there is no runner to emit through — and "your pull request
    // merged" is exactly the fact that has to survive to the transcript the
    // user comes back to.
    persistNoticeUnattached(deps.chatHistoryManager, claim.sessionId, message, "info");
  });

  return { result: "settled", merged: true };
}

/**
 * Resolve a claim whose session has moved on — a repointed `origin`, a re-arm, a
 * replacement pull request.
 *
 * This is the one path where a merge ShipIt may have performed has nowhere in
 * the session's state to go, and the previous code took that as licence to write
 * a `console.warn` and delete the row. Requirement 9 asks for a record in the
 * TRANSCRIPT, not in the process log, and a deleted row is the last copy of the
 * evidence — so the question is asked of GitHub instead, against the claim's own
 * repository (cross-agent review finding).
 *
 * Session state is still left completely alone: nothing here promotes, anchors
 * or archives. The transcript gains one line saying what happened to a commit
 * this session asked to merge, and the row goes.
 */
async function settleWithoutSession(
  deps: AgentMergeSettlementDeps,
  claim: AgentMergeClaim,
  target: { owner: string; repo: string },
): Promise<SettlementOutcome> {
  const recordId = mergeRecordId(claim);
  // A deleted session has no transcript to record into, and its claim row went
  // with it under `ON DELETE CASCADE`. Nothing to ask GitHub about.
  if (!deps.sessionManager.get(claim.sessionId)) {
    deps.claims.release(claim.sessionId, claim.expectedSha);
    return { result: "not-merged" };
  }
  const facts = await deps.prStatusPoller?.readPrByNumber(target.owner, target.repo, claim.prNumber);
  if (facts === undefined || facts === null) {
    // Keep the row: the answer is still available on the next pass, and this is
    // the case where deleting it destroys the only evidence there is.
    return { result: "deferred", reason: "GitHub did not answer about the moved pull request" };
  }
  if (facts.merged_at === null || facts.head_sha !== claim.expectedSha) {
    console.warn(
      `[agent-merge] ${recordId} — the session's pull request moved on, and the claimed commit is `
      + "not merged. Nothing to record.",
    );
    deps.claims.release(claim.sessionId, claim.expectedSha);
    return { result: "not-merged" };
  }
  deps.claims.releaseAfterRecording(claim.sessionId, claim.expectedSha, () => {
    persistNoticeUnattached(
      deps.chatHistoryManager,
      claim.sessionId,
      `The commit this session asked to merge (${claim.expectedSha.slice(0, 8)}) is now merged as `
      + `pull request #${claim.prNumber} in ${target.owner}/${target.repo}. This session has since `
      + `moved to a different pull request, so its own state is unchanged. (${recordId})`,
      "info",
    );
  });
  return { result: "settled", merged: true };
}

/**
 * Resolve every outstanding claim that is safe to touch.
 *
 * Runs at startup, at the end of any turn on that session, and when a session is
 * activated. Three triggers rather than one because a transient GitHub or
 * authentication failure must not strand a row until the next process restart —
 * and all three are cheap, because a direct claim never waits for anything
 * external: it is created inside a turn and resolvable as soon as that turn ends.
 */
export async function reconcileAgentMergeClaims(
  deps: AgentMergeSettlementDeps,
  opts: { sessionId?: string } = {},
): Promise<void> {
  const claims = opts.sessionId
    ? [deps.claims.get(opts.sessionId)].filter((c): c is AgentMergeClaim => c !== null)
    : deps.claims.list();

  for (const claim of claims) {
    if (hasActiveTurn(deps, claim)) continue;
    try {
      const outcome = await settleAgentMerge(deps, claim, {
        witnessed: false,
        // Checked again immediately before anything is written, not only here:
        // this loop awaits a GitHub round trip, and a turn that starts during it
        // would otherwise be settled behind its back — the exact hazard the
        // check exists for (cross-agent review finding).
        stillSafeToSettle: () => !hasActiveTurn(deps, claim),
      });
      if (outcome.result === "deferred") {
        console.warn(
          `[agent-merge] claim for ${claim.sessionId} PR #${claim.prNumber} deferred: ${outcome.reason}`,
        );
      }
    } catch (err) {
      // A throw must not stop the other claims, and must not delete this one.
      console.error(`[agent-merge] reconciling ${claim.sessionId} PR #${claim.prNumber} failed:`, err);
    }
  }
}

/**
 * Is a turn running on this session right now?
 *
 * Deliberately broader than "the claim's own turn": reconciliation must stand
 * down for ANY active turn, because the hazard is writing session state while
 * something else is editing and pushing — not whether the ids match.
 */
function hasActiveTurn(deps: AgentMergeSettlementDeps, claim: AgentMergeClaim): boolean {
  const runner = deps.runnerRegistry?.get(claim.sessionId);
  if (!runner) return false;
  return runner.agentBusy || runner.running;
}

/** The turn identity to record on a claim, or null when no turn is running. */
export function activeTurnIdFor(
  runnerRegistry: SessionRunnerRegistry | undefined,
  sessionId: string,
): string | null {
  const runner = runnerRegistry?.get(sessionId);
  if (!runner?.running) return null;
  return currentTurnId(runner.turnEpoch ?? 0);
}
