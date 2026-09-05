/**
 * docs/287-agent-merge-per-repo §4 — settling an agent merge, and recovering one
 * whose outcome was never learned.
 *
 * A merge is not finished until the session says so, or the agent's next
 * `shipit branch reset-to-base` reads `not-merged` for work that shipped.
 * Settlement promotes, records, then drops the claim.
 *
 * `witnessed` decides what the record may SAY: a REST success records "the agent
 * merged it", recovery only "that commit is now merged", since a user or GitHub
 * auto-merge could have landed it (`merge-attribution.ts`). Reconciliation
 * stands down for any active turn, which could still be pushing.
 */

import type { SessionManager } from "../sessions.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { ChatHistoryManager } from "../chat-history.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { AgentMergeClaim, AgentMergeClaimStore } from "../agent-merge-claims.js";
import { mergeRecordId } from "../agent-merge-claims.js";
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
  /** Not merged after all — the claim is gone, nothing recorded. */
  | { result: "not-merged" }
  /** No answer, or the session moved on. The claim stays. */
  | { result: "deferred"; reason: string };

/** Both halves: a number alone could name a different repository's #N. */
function sessionStillOwns(deps: AgentMergeSettlementDeps, claim: AgentMergeClaim): boolean {
  const session = deps.sessionManager.get(claim.sessionId);
  if (!session) return false;
  if (session.prNumber !== claim.prNumber) return false;
  if (session.prRepoId !== claim.repoId) return false;
  return repoId(session.remoteUrl ?? "") === claim.repoId;
}

/** From the CLAIM's identity — a repointed session names the wrong repository. */
function ownerRepoFor(claim: AgentMergeClaim): { owner: string; repo: string } | null {
  return ownerRepoFromRepoId(claim.repoId);
}

/**
 * Settle one claim: promote the pull request, record the merge, release the row.
 * Pass `witnessed` only when THIS process saw a merge response come back.
 */
export async function settleAgentMerge(
  deps: AgentMergeSettlementDeps,
  claim: AgentMergeClaim,
  opts: {
    witnessed: boolean;
    /** The claiming turn, from {@link captureTurn}. Witnessed settlements only. */
    turn?: TurnToken | null;
    /** Re-asked immediately before the first write, past the caller's await. */
    stillSafeToSettle?: () => boolean;
  },
): Promise<SettlementOutcome> {
  // The ROW, not the object handed in: a stale copy re-runs once-per-merge work.
  const live = deps.claims.get(claim.sessionId);
  if (live?.expectedSha !== claim.expectedSha) {
    return { result: "deferred", reason: "the claim has already been resolved" };
  }
  // docs/288 — a request has not been attempted, so "is it merged?" has no
  // bearing on it and a `not-merged` answer here would DELETE it.
  if (live.state === "pending") {
    return { result: "deferred", reason: "this is a merge request the executor has not attempted" };
  }
  if (!deps.prStatusPoller) return { result: "deferred", reason: "no pull-request poller" };
  const target = ownerRepoFor(claim);
  if (!target) return { result: "deferred", reason: "the claim has no readable repository" };

  // Before the promotion, which is what writes session state.
  if (!sessionStillOwns(deps, claim)) {
    return settleWithoutSession(deps, claim, target);
  }

  // req 9 — a settlement inside a turn must still be that turn's: a round trip
  // separates the merge from this. Reconciliation has no turn and is exempt.
  if (opts.witnessed && deps.runnerRegistry) {
    const active = captureTurn(deps.runnerRegistry, claim.sessionId);
    if (active !== null && !isSameTurn(active, opts.turn)) {
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
    // After GitHub answered, before anything is written. The same checks outside
    // decide the ROW's fate; this decides whether to write.
    guard: (pr) => {
      if (opts.stillSafeToSettle && !opts.stillSafeToSettle()) return false;
      // Witnessed is exempt: the REST call pinned `expected_sha`, and `head_sha`
      // reads differently on a repository that deletes the branch.
      if (!opts.witnessed && pr.merged_at !== null && pr.head_sha !== claim.expectedSha) return false;
      return true;
    },
  });
  if (!read) return { result: "deferred", reason: "GitHub did not answer" };
  const facts = read.pr;

  if (facts.merged_at === null) {
    // `settling` means a merge response CAME BACK, so an open answer here is a
    // stale read. Only a `merging` row may resolve as not-merged.
    if (live.state === "settling") {
      return { result: "deferred", reason: "the pull request does not read as merged yet" };
    }
    // Resolved from the tuple, never from the shape of an error.
    deps.claims.release(claim.sessionId, claim.expectedSha);
    return { result: "not-merged" };
  }

  // Merged — but at THIS commit? A force-push merges another head, and
  // `merged_at` cannot tell them apart. The guard already stopped the write.
  if (!opts.witnessed && facts.head_sha !== claim.expectedSha) {
    console.warn(
      `[agent-merge] ${mergeRecordId(claim)} — PR #${claim.prNumber} merged at `
      + `${facts.head_sha ?? "an unknown commit"}, not the claimed commit. Recording nothing.`,
    );
    deps.claims.release(claim.sessionId, claim.expectedSha);
    return { result: "not-merged" };
  }

  // The only guard reason left: a turn started while GitHub was answering.
  if (!read.promoted) return { result: "deferred", reason: "a turn started on this session" };

  const message = opts.witnessed
    ? `Merged pull request #${claim.prNumber} at ${claim.expectedSha.slice(0, 8)}.`
    // Narrower on purpose — see `witnessed` in the module comment.
    : `The commit this session asked to merge (${claim.expectedSha.slice(0, 8)}) is now merged as `
      + `pull request #${claim.prNumber}.`;

  deps.claims.releaseAfterRecording(claim.sessionId, claim.expectedSha, () => {
    // Unattached: a settlement can run post-turn, with no runner to emit through.
    persistNoticeUnattached(deps.chatHistoryManager, claim.sessionId, message, "info");
  });

  return { result: "settled", merged: true };
}

/**
 * Resolve a claim whose session has moved on. The merge may still have happened
 * and the row is the last copy of that evidence, so GitHub is asked about the
 * CLAIM's repository and the answer goes in the transcript (req 9). Nothing here
 * promotes, anchors or archives.
 */
async function settleWithoutSession(
  deps: AgentMergeSettlementDeps,
  claim: AgentMergeClaim,
  target: { owner: string; repo: string },
): Promise<SettlementOutcome> {
  const recordId = mergeRecordId(claim);
  // No transcript to record into, and the row went with it under CASCADE.
  if (!deps.sessionManager.get(claim.sessionId)) {
    deps.claims.release(claim.sessionId, claim.expectedSha);
    return { result: "not-merged" };
  }
  const facts = await deps.prStatusPoller?.readPrByNumber(target.owner, target.repo, claim.prNumber);
  if (facts === undefined || facts === null) {
    // Keep the row — deleting it here destroys the only evidence there is.
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
 * Resolve every outstanding claim that is safe to touch. Three triggers —
 * startup, end of turn, session activation — because a transient GitHub failure
 * must not strand a row, which also blocks the session's next merge.
 */
export async function reconcileAgentMergeClaims(
  deps: AgentMergeSettlementDeps,
  opts: { sessionId?: string } = {},
): Promise<void> {
  const claims = opts.sessionId
    // `getAttempt`, not `get`: `settleAgentMerge` refuses a request on its own,
    // so this is not what keeps one safe — it keeps the end of every turn from
    // logging a deferral for a request that is simply still waiting.
    ? [deps.claims.getAttempt(opts.sessionId)].filter((c): c is AgentMergeClaim => c !== null)
    : deps.claims.list();

  for (const claim of claims) {
    if (hasActiveTurn(deps, claim)) continue;
    try {
      const outcome = await settleAgentMerge(deps, claim, {
        witnessed: false,
        // Re-checked past the await below: a turn can start during it.
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
 * Broader than "the claim's own turn": ANY turn may be editing and pushing.
 *
 * docs/288 adds the second clause, and it is not a turn at all. The executor
 * writes `merging` and then awaits GitHub with no turn running, so without it a
 * session activation reconciles that row, reads the pull request as still open,
 * and DELETES it — after which GitHub accepts the outstanding request and the
 * merge has no record anywhere. It is checked on the store rather than on the
 * runner because a session with no container has no runner to ask.
 */
function hasActiveTurn(deps: AgentMergeSettlementDeps, claim: AgentMergeClaim): boolean {
  if (deps.claims.isMergeInFlight(claim.sessionId)) return true;
  const runner = deps.runnerRegistry?.get(claim.sessionId);
  if (!runner) return false;
  return runner.agentBusy || runner.running;
}

/**
 * A running turn's identity, held in memory for one request.
 *
 * The RUNNER as well as the epoch: `turnEpoch` restarts at 0 whenever a runner
 * is recreated, so an epoch alone reads a fresh runner's first turn as the turn
 * that claimed the merge. Never persisted — the only settlement that consults it
 * runs inside the request that captured it.
 */
export interface TurnToken {
  runner: object;
  epoch: number;
}

/** The turn running on this session, or null when none is — the route's 409. */
export function captureTurn(
  runnerRegistry: SessionRunnerRegistry | undefined,
  sessionId: string,
): TurnToken | null {
  const runner = runnerRegistry?.get(sessionId);
  if (!runner?.running) return null;
  return { runner, epoch: runner.turnEpoch ?? 0 };
}

function isSameTurn(active: TurnToken, claimed: TurnToken | null | undefined): boolean {
  return claimed?.runner === active.runner && claimed.epoch === active.epoch;
}
