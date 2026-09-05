/**
 * docs/287-agent-merge-per-repo §4 — settling an agent merge, and recovering one
 * whose outcome was never learned.
 *
 * A merge GitHub performed is not finished until the session says so:
 * `merged_at`, the merged snapshot, `mergedHeadSha` and reset eligibility have
 * to land, or the agent's next step — `shipit branch reset-to-base` — reads
 * `not-merged` for work that shipped. Settlement promotes, records, then drops
 * the claim.
 *
 * `witnessed` decides what the record may SAY. A REST success records "the agent
 * merged it"; recovery that merely finds `expected_sha` merged records "the
 * agent asked for this commit, and it is now merged", because a user or GitHub's
 * own auto-merge could have landed it (`merge-attribution.ts`).
 *
 * Reconciliation must not race the turn a claim belongs to: reattachment returns
 * while the adopted turn keeps editing and pushing, so settling behind its back
 * would mark the session merged mid-turn. A session with an active turn is
 * skipped and picked up when that turn ends.
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
 * Does this session still own the claim's pull request? Both halves are
 * required: pull-request numbers coincide across repositories, so a number alone
 * could point the promotion at a different repository's #N.
 */
function sessionStillOwns(deps: AgentMergeSettlementDeps, claim: AgentMergeClaim): boolean {
  const session = deps.sessionManager.get(claim.sessionId);
  if (!session) return false;
  if (session.prNumber !== claim.prNumber) return false;
  if (session.prRepoId !== claim.repoId) return false;
  return repoId(session.remoteUrl ?? "") === claim.repoId;
}

/**
 * The pair the GitHub API takes, from the CLAIM's identity rather than the
 * session's current `remoteUrl` — a repointed session would answer about the
 * wrong repository.
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
    /** Re-asked immediately before the first write. A caller that awaited I/O
     * to get here cannot rely on a check made before that await. */
    stillSafeToSettle?: () => boolean;
  },
): Promise<SettlementOutcome> {
  // Operates on the ROW, not the object handed in: the caller's copy can be
  // stale, and re-promoting a settled claim re-runs once-per-merge effects.
  const live = deps.claims.get(claim.sessionId);
  if (live?.expectedSha !== claim.expectedSha) {
    return { result: "deferred", reason: "the claim has already been resolved" };
  }
  if (!deps.prStatusPoller) return { result: "deferred", reason: "no pull-request poller" };
  const target = ownerRepoFor(claim);
  if (!target) return { result: "deferred", reason: "the claim has no readable repository" };

  // Before the promotion, which is what writes session state.
  if (!sessionStillOwns(deps, claim)) {
    return settleWithoutSession(deps, claim, target);
  }

  // req 9 — a settlement running INSIDE a turn must still be that turn's. The
  // merge and the settlement are separated by a GitHub round trip, and a turn
  // that ended in between no longer owns the state this writes. Reconciliation
  // runs with no turn at all and is exempt; its own rule is stronger.
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
    // are also checked outside this call, on the wrong side of the await —
    // they decide what to do with the ROW; this decides whether to write.
    guard: (pr) => {
      if (opts.stillSafeToSettle && !opts.stillSafeToSettle()) return false;
      // A witnessed merge is exempt: the REST call pinned `expected_sha`, so
      // GitHub enforced the match, and `head_sha` can legitimately read
      // differently on a repository that deletes the branch.
      if (!opts.witnessed && pr.merged_at !== null && pr.head_sha !== claim.expectedSha) return false;
      return true;
    },
  });
  if (!read) return { result: "deferred", reason: "GitHub did not answer" };
  const facts = read.pr;

  if (facts.merged_at === null) {
    // A `settling` row means a merge response CAME BACK, and GitHub's
    // read-after-write is not instant — so an open answer here is a stale read,
    // not a contradiction. Only a `merging` row may resolve as not-merged.
    if (live.state === "settling") {
      return { result: "deferred", reason: "the pull request does not read as merged yet" };
    }
    // Resolved from the tuple, never from the shape of an error.
    deps.claims.release(claim.sessionId, claim.expectedSha);
    return { result: "not-merged" };
  }

  // It merged — but was it THIS commit? A pull request can be force-pushed and
  // merged at another head, and `merged_at` cannot tell those apart. The guard
  // already stopped the promotion; this decides what to do with the row.
  if (!opts.witnessed && facts.head_sha !== claim.expectedSha) {
    console.warn(
      `[agent-merge] ${mergeRecordId(claim)} — PR #${claim.prNumber} merged at `
      + `${facts.head_sha ?? "an unknown commit"}, not the claimed commit. Recording nothing.`,
    );
    deps.claims.release(claim.sessionId, claim.expectedSha);
    return { result: "not-merged" };
  }

  // The only remaining reason the guard refused: a turn started while GitHub
  // was answering. Nothing was written, so the row stays for the next pass.
  if (!read.promoted) return { result: "deferred", reason: "a turn started on this session" };

  const message = opts.witnessed
    ? `Merged pull request #${claim.prNumber} at ${claim.expectedSha.slice(0, 8)}.`
    // Narrower on purpose — see `witnessed` in the module comment.
    : `The commit this session asked to merge (${claim.expectedSha.slice(0, 8)}) is now merged as `
      + `pull request #${claim.prNumber}.`;

  deps.claims.releaseAfterRecording(claim.sessionId, claim.expectedSha, () => {
    // Unattached by construction: a settlement can run post-turn or after a
    // restart, when there is no runner to emit through.
    persistNoticeUnattached(deps.chatHistoryManager, claim.sessionId, message, "info");
  });

  return { result: "settled", merged: true };
}

/**
 * Resolve a claim whose session has moved on — a repointed `origin`, a re-arm, a
 * replacement pull request.
 *
 * The merge may still have happened, and the row is the last copy of that
 * evidence, so the question is asked of GitHub against the CLAIM's repository
 * and the answer goes in the transcript (req 9). Session state is left alone:
 * nothing here promotes, anchors or archives.
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
      + "moved to a different pull request, so its own state is unchanged.",
      "info",
    );
  });
  return { result: "settled", merged: true };
}

/**
 * Resolve every outstanding claim that is safe to touch. Runs at startup, at the
 * end of any turn on that session, and on session activation — three triggers
 * because a transient GitHub failure must not strand a row (which, with
 * single-flight claims, also blocks the session's next merge) until a restart.
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
        // Re-checked before anything is written: this loop awaits a GitHub
        // round trip, and a turn can start during it.
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
 * Is a turn running on this session? Broader than "the claim's own turn" on
 * purpose: the hazard is writing session state while anything is editing and
 * pushing, not whether the ids match.
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
