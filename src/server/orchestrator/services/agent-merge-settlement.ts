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

export type SettlementOutcome =
  | { result: "settled"; merged: true }
  | { result: "not-merged" }
  | { result: "deferred"; reason: string };

// Direct merges return a command reply; automatic requests need a persisted result.
function noticeForRequest(
  deps: AgentMergeSettlementDeps,
  claim: AgentMergeClaim,
  message: string,
): void {
  if (claim.origin !== "auto") return;
  persistNoticeUnattached(deps.chatHistoryManager, claim.sessionId, message, "warn");
}

function sessionStillOwns(deps: AgentMergeSettlementDeps, claim: AgentMergeClaim): boolean {
  const session = deps.sessionManager.get(claim.sessionId);
  if (!session) return false;
  if (session.prNumber !== claim.prNumber) return false;
  if (session.prRepoId !== claim.repoId) return false;
  return repoId(session.remoteUrl ?? "") === claim.repoId;
}

function ownerRepoFor(claim: AgentMergeClaim): { owner: string; repo: string } | null {
  return ownerRepoFromRepoId(claim.repoId);
}

/** Set witnessed only when this process received a successful merge response. */
export async function settleAgentMerge(
  deps: AgentMergeSettlementDeps,
  claim: AgentMergeClaim,
  opts: {
    witnessed: boolean;
    turn?: TurnToken | null;
    stillSafeToSettle?: () => boolean;
  },
): Promise<SettlementOutcome> {
  const live = deps.claims.get(claim.sessionId);
  if (live?.expectedSha !== claim.expectedSha) {
    return { result: "deferred", reason: "the claim has already been resolved" };
  }
  // A pending request has not been attempted; reconciliation must not discard it.
  if (live.state === "pending") {
    return { result: "deferred", reason: "this is a merge request the executor has not attempted" };
  }
  if (!deps.prStatusPoller) return { result: "deferred", reason: "no pull-request poller" };
  const target = ownerRepoFor(claim);
  if (!target) return { result: "deferred", reason: "the claim has no readable repository" };

  if (!sessionStillOwns(deps, claim)) {
    return settleWithoutSession(deps, claim, target);
  }

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
    // Recheck after the GitHub await, before promotion writes session state.
    guard: (pr) => {
      if (opts.stillSafeToSettle && !opts.stillSafeToSettle()) return false;
      // Witnessed merges pinned expected_sha; branch deletion can change head_sha.
      if (!opts.witnessed && pr.merged_at !== null && pr.head_sha !== claim.expectedSha) return false;
      return true;
    },
  });
  if (!read) return { result: "deferred", reason: "GitHub did not answer" };
  const facts = read.pr;

  if (facts.merged_at === null) {
    // Recheck the row after the await; a replacement merge may now be in flight.
    const now = deps.claims.get(claim.sessionId);
    if (
      now?.expectedSha !== claim.expectedSha || now.prNumber !== claim.prNumber
      || now.state !== live.state || deps.claims.isMergeInFlight(claim.sessionId)
    ) {
      return { result: "deferred", reason: "the claim changed while GitHub was answering" };
    }
    // Settling already has a successful merge response; an open reading is stale.
    if (live.state === "settling") {
      return { result: "deferred", reason: "the pull request does not read as merged yet" };
    }
    noticeForRequest(
      deps, claim,
      `ShipIt checked, and pull request #${claim.prNumber} did not merge at `
      + `${claim.expectedSha.slice(0, 8)}. Nothing was merged; ask again to retry.`,
    );
    deps.claims.release(claim.sessionId, claim.expectedSha);
    return { result: "not-merged" };
  }

  if (!opts.witnessed && facts.head_sha !== claim.expectedSha) {
    console.warn(
      `[agent-merge] ${mergeRecordId(claim)} — PR #${claim.prNumber} merged at `
      + `${facts.head_sha ?? "an unknown commit"}, not the claimed commit. Recording nothing.`,
    );
    noticeForRequest(
      deps, claim,
      `Pull request #${claim.prNumber} merged at a different commit than the `
      + `${claim.expectedSha.slice(0, 8)} this session asked ShipIt to merge. Nothing this session `
      + "asked for was merged.",
    );
    deps.claims.release(claim.sessionId, claim.expectedSha);
    return { result: "not-merged" };
  }

  if (!read.promoted) return { result: "deferred", reason: "a turn started on this session" };

  const message = opts.witnessed
    ? `Merged pull request #${claim.prNumber} at ${claim.expectedSha.slice(0, 8)}.`
    // Recovery proves the commit merged, but not who merged it.
    : `The commit this session asked to merge (${claim.expectedSha.slice(0, 8)}) is now merged as `
      + `pull request #${claim.prNumber}.`;

  deps.claims.releaseAfterRecording(claim.sessionId, claim.expectedSha, () => {
    persistNoticeUnattached(deps.chatHistoryManager, claim.sessionId, message, "info");
  });

  return { result: "settled", merged: true };
}

// Use the claim's repository after a session moves; do not promote its new PR.
async function settleWithoutSession(
  deps: AgentMergeSettlementDeps,
  claim: AgentMergeClaim,
  target: { owner: string; repo: string },
): Promise<SettlementOutcome> {
  const recordId = mergeRecordId(claim);
  if (!deps.sessionManager.get(claim.sessionId)) {
    deps.claims.release(claim.sessionId, claim.expectedSha);
    return { result: "not-merged" };
  }
  const facts = await deps.prStatusPoller?.readPrByNumber(target.owner, target.repo, claim.prNumber);
  if (facts === undefined || facts === null) {
    return { result: "deferred", reason: "GitHub did not answer about the moved pull request" };
  }
  if (facts.merged_at === null || facts.head_sha !== claim.expectedSha) {
    console.warn(
      `[agent-merge] ${recordId} — the session's pull request moved on, and the claimed commit is `
      + "not merged. Nothing to record.",
    );
    noticeForRequest(
      deps, claim,
      `ShipIt checked, and the commit this session asked to merge (${claim.expectedSha.slice(0, 8)}) `
      + `is not merged in pull request #${claim.prNumber}. Nothing was merged.`,
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

export async function reconcileAgentMergeClaims(
  deps: AgentMergeSettlementDeps,
  opts: { sessionId?: string } = {},
): Promise<void> {
  const claims = opts.sessionId
    ? [deps.claims.getAttempt(opts.sessionId)].filter((c): c is AgentMergeClaim => c !== null)
    : deps.claims.list();

  for (const claim of claims) {
    if (hasActiveTurn(deps, claim)) continue;
    try {
      const outcome = await settleAgentMerge(deps, claim, {
        witnessed: false,
        stillSafeToSettle: () => !hasActiveTurn(deps, claim),
      });
      if (outcome.result === "deferred") {
        console.warn(
          `[agent-merge] claim for ${claim.sessionId} PR #${claim.prNumber} deferred: ${outcome.reason}`,
        );
      }
    } catch (err) {
      console.error(`[agent-merge] reconciling ${claim.sessionId} PR #${claim.prNumber} failed:`, err);
    }
  }
}

// A merge request can be in flight with no runner or active turn.
function hasActiveTurn(deps: AgentMergeSettlementDeps, claim: AgentMergeClaim): boolean {
  if (deps.claims.isMergeInFlight(claim.sessionId)) return true;
  const runner = deps.runnerRegistry?.get(claim.sessionId);
  if (!runner) return false;
  return runner.agentBusy || runner.running;
}

// Include runner identity because a replacement runner restarts the epoch at zero.
export interface TurnToken {
  runner: object;
  epoch: number;
}

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
