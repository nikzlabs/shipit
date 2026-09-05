/**
 * docs/288-agent-merge-arming — carrying out `gh pr merge --auto`.
 *
 * The agent asks for a merge and the turn ends; nothing wakes a session when CI
 * turns green, so ShipIt performs the merge itself, at the exact commit the
 * agent asked for and never at whatever the branch has become (req 2).
 *
 * One rule decides every tick: **wait only while the checks are running, merge
 * when they are green, and end the request with a notice in every other case.**
 * Ending rather than waiting is deliberate — a request that never terminates is
 * an unbounded background job the user cannot see, and the notice is what tells
 * the agent the merge is not coming.
 *
 * Everything after "merge" is docs/287's: the same observation, the same durable
 * claim, the same settlement. This file adds the waiting and the exclusion.
 */

import type { SessionManager } from "../sessions.js";
import type { RepoStore } from "../repo-store.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { ChatHistoryManager } from "../chat-history.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { MergeAttempt } from "../github-auth-prs.js";
import type { AgentMergeClaim, AgentMergeClaimStore } from "../agent-merge-claims.js";
import { persistNoticeUnattached } from "../chat-card-persistence.js";
import { ownerRepoFromRepoId, repoId } from "../git-utils.js";
import { mergeDisposition } from "../pr-target.js";
import { readMergeObservation } from "./merge-gate.js";
import { settleAgentMerge } from "./agent-merge-settlement.js";
import { releaseQueuedTurn } from "../queue-drain.js";

export interface AgentMergeExecutorDeps {
  claims: AgentMergeClaimStore;
  sessionManager: SessionManager;
  chatHistoryManager: ChatHistoryManager;
  repoStore: Pick<RepoStore, "allowsAgentMerge">;
  githubAuthManager: GitHubAuthManager;
  prStatusPoller?: PrStatusPoller;
  runnerRegistry?: SessionRunnerRegistry;
}

/** What one pass decided about one request. Returned for the tests and the log. */
export type RequestOutcome =
  | { result: "waiting"; reason: string }
  | { result: "merged" }
  | { result: "ended"; reason: string };

const TICK_MS = 20_000;

/**
 * The loop. Ticks only while a request exists, so an idle ShipIt makes no GitHub
 * calls at all and needs no polling gate of its own.
 */
export class AgentMergeExecutor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: AgentMergeExecutorDeps) {}

  /**
   * Start ticking. **Call this after `reattachInFlightTurns()`**: until the
   * adoption sweep completes the runner registry is empty, so "is this session
   * busy?" answers no for everything and a surviving turn's pre-turn head could
   * be merged while that turn still holds uncommitted work.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Run one pass now — on arming, so a green pull request does not wait a tick. */
  async tick(): Promise<void> {
    // Not re-entrant: a slow GitHub answer must not overlap the next interval.
    if (this.running) return;
    this.running = true;
    try {
      await runAgentMergeRequests(this.deps);
    } catch (err) {
      console.error("[agent-merge] request pass failed:", err);
    } finally {
      this.running = false;
    }
  }
}

/** One pass over every request. A throw on one must not strand the others. */
export async function runAgentMergeRequests(deps: AgentMergeExecutorDeps): Promise<void> {
  for (const claim of deps.claims.listPending()) {
    try {
      const outcome = await runOneRequest(deps, claim);
      if (outcome.result !== "waiting") {
        const why = outcome.result === "ended" ? ` — ${outcome.reason}` : "";
        console.log(`[agent-merge] request ${claim.sessionId} PR #${claim.prNumber}: ${outcome.result}${why}`);
      }
    } catch (err) {
      console.error(`[agent-merge] request ${claim.sessionId} PR #${claim.prNumber} failed:`, err);
    }
  }
}

export async function runOneRequest(
  deps: AgentMergeExecutorDeps,
  claim: AgentMergeClaim,
): Promise<RequestOutcome> {
  const target = ownerRepoFromRepoId(claim.repoId);
  if (!target) return end(deps, claim, "ShipIt could not read the repository this request names.");

  const session = deps.sessionManager.get(claim.sessionId);
  if (!session) {
    // The cascade normally takes the row with the session; a race gets here.
    deps.claims.releasePending(claim.sessionId, claim.expectedSha);
    return { result: "ended", reason: "the session is gone" };
  }

  // req 2 — the request names a repository and a pull request, and the session
  // can be repointed while it waits. Without this the grant is read from the
  // session's CURRENT remote while the merge is sent to the claim's repository:
  // arm in A, repoint origin to B where merging is allowed, and B's permission
  // merges A. `setRemoteUrl`/`setBranch` clear the provenance, so a repointed
  // session fails the second half here even if the first were somehow satisfied.
  if (
    repoId(session.remoteUrl ?? "") !== claim.repoId
    || session.prNumber !== claim.prNumber
    || session.prRepoId !== claim.repoId
  ) {
    return end(
      deps, claim,
      `Cancelled the merge request for pull request #${claim.prNumber} in `
      + `${target.owner}/${target.repo}: it is no longer the pull request ShipIt opened for this `
      + "session. Nothing was merged.",
    );
  }

  // req 4 — the permission is withdrawable at any time, and this request was
  // recorded before an arbitrary wait. Revocation deletes pending rows; this is
  // what covers the row that was mid-pass while it did. Sound only because the
  // identity check above has established that the session's remote IS the
  // claim's repository.
  if (!isStillGranted(deps, claim)) {
    return end(
      deps, claim,
      `The permission to merge in ${target.owner}/${target.repo} was withdrawn, so ShipIt did not `
      + `merge pull request #${claim.prNumber}.`,
    );
  }

  // req 6, first half — never while the agent is working. Checked before the
  // read, and again under the hold below, because both are cheap and the window
  // between them is a GitHub round trip.
  if (!isIdle(deps, claim.sessionId)) return { result: "waiting", reason: "the session is busy" };

  const observation = await readMergeObservation(
    deps.githubAuthManager, target.owner, target.repo, claim.prNumber,
  );
  if (observation.kind === "unreadable") {
    // Transient by ASSUMPTION, and the assumption has a limit: a deleted
    // repository, a revoked credential or a pull request ShipIt can no longer
    // see would otherwise leave the request pending for ever with the agent
    // never told the merge is not coming. Counted rather than timed, and in
    // memory rather than in a column, because the question is "have this
    // process's own reads kept failing?" — a restart re-earns the benefit of
    // the doubt, which is the right answer for an outage that spanned it.
    const failures = (unreadableCounts.get(unreadableKey(claim)) ?? 0) + 1;
    unreadableCounts.set(unreadableKey(claim), failures);
    if (failures < UNREADABLE_LIMIT) return { result: "waiting", reason: observation.reason };
    return end(
      deps, claim,
      `Cancelled the merge request for pull request #${claim.prNumber}: ShipIt could not read it `
      + `${failures} times in a row (${observation.reason}). Nothing was merged. Check that ShipIt `
      + "still has access to this repository, then ask again.",
    );
  }
  // Any answer at all clears the run — the limit is on CONSECUTIVE failures.
  unreadableCounts.delete(unreadableKey(claim));

  // req 3 — the commit is the request. Checked before state and checks alike, so
  // a branch that moved is reported as such rather than as a CI answer about a
  // commit nobody asked about.
  if (observation.headRefOid !== claim.expectedSha) {
    return end(
      deps, claim,
      `Cancelled the merge request for pull request #${claim.prNumber}: the branch has moved past `
      + `${claim.expectedSha.slice(0, 8)}, the commit ShipIt was asked to merge. Nothing was merged. `
      + "Ask again to merge the new commit.",
    );
  }

  if (observation.prState === "MERGED") {
    // Somebody else landed exactly this commit — the user, or the pull-request
    // card's own auto-merge. docs/287's recovery settlement records it with the
    // narrower wording, since ShipIt cannot prove it performed the merge.
    return (await settle(deps, claim, false)) ? { result: "merged" } : { result: "waiting", reason: "settling" };
  }
  if (observation.prState !== "OPEN") {
    return end(
      deps, claim,
      `Cancelled the merge request for pull request #${claim.prNumber}: it is `
      + `${observation.prState.toLowerCase()} and was not merged.`,
    );
  }
  if (observation.isDraft) {
    return end(
      deps, claim,
      `Cancelled the merge request for pull request #${claim.prNumber}: it is a draft. Mark it ready `
      + "and ask again.",
    );
  }
  if (observation.rollupState === "FAILURE" || observation.rollupState === "ERROR") {
    return end(
      deps, claim,
      `Cancelled the merge request for pull request #${claim.prNumber}: its checks failed at `
      + `${claim.expectedSha.slice(0, 8)}. Fix CI and push; ShipIt does not wait for a re-run of a `
      + "commit that has already failed.",
    );
  }
  // A whitelist, like docs/287's gate: a review state GitHub adds tomorrow must
  // not fall through into a merge.
  if (observation.reviewDecision !== null && observation.reviewDecision !== "APPROVED") {
    return end(
      deps, claim,
      `Cancelled the merge request for pull request #${claim.prNumber}: GitHub reports it needs `
      + `review (${observation.reviewDecision}). Ask again once it is approved.`,
    );
  }

  // req 1 — the checks that pass must be THIS commit's. A rollup describing an
  // earlier commit is the ordinary shape moments after the push that armed the
  // request, and reading its `SUCCESS` would merge a head CI has never seen —
  // the same fail-open docs/287's `head-moved-since-checks` rule exists to stop,
  // which arming deliberately skips at record time and must not skip here.
  if (observation.rollupCommitOid !== observation.headRefOid) {
    return { result: "waiting", reason: "the checks for this commit have not reported" };
  }

  // The one waiting state.
  if (observation.rollupState === "PENDING" || observation.rollupState === "EXPECTED") {
    return { result: "waiting", reason: "checks are running" };
  }

  if (observation.rollupState === null) {
    // Zero checks is either a repository with no CI or a push whose workflows
    // have not registered yet. docs/287's grace window is the same answer here.
    const wait = await deps.prStatusPoller?.awaitCiGraceDecision({
      repoUrl: session.remoteUrl,
      repoKey: `${target.owner}/${target.repo}`,
      prNumber: claim.prNumber,
      headSha: claim.expectedSha,
      ...(session.branch ? { headBranch: session.branch } : {}),
    });
    if (wait) return { result: "waiting", reason: "no checks have registered yet" };
  } else if (observation.rollupState !== "SUCCESS") {
    return end(
      deps, claim,
      `Cancelled the merge request for pull request #${claim.prNumber}: GitHub reports its checks as `
      + `${observation.rollupState}, which ShipIt does not read as passing.`,
    );
  }

  return performMerge(deps, claim, target);
}

/**
 * The merge itself, under the hold. Everything between taking the hold and the
 * `finally` is the window a turn may not start in (req 6).
 */
async function performMerge(
  deps: AgentMergeExecutorDeps,
  claim: AgentMergeClaim,
  target: { owner: string; repo: string },
): Promise<RequestOutcome> {
  const runner = deps.runnerRegistry?.get(claim.sessionId);
  // Two holds, because they cover different absences. `mergeHold` is what the
  // turn-admission sites read, and needs a runner. The store's in-flight mark
  // needs none: it is what stops RECONCILIATION resolving this row mid-call, and
  // it is what a runner created during the call is seeded from.
  deps.claims.markMergeInFlight(claim.sessionId);
  if (runner) runner.mergeHold = true;
  try {
    if (!isIdle(deps, claim.sessionId, { underHold: true })) {
      return { result: "waiting", reason: "a turn started while ShipIt was reading GitHub" };
    }
    // `pending → merging`, durably, BEFORE the call: it can reject after GitHub
    // accepted it, and a success with nowhere to land is a merge with no record.
    // The `state = 'pending'` filter is the single-flight point.
    if (!deps.claims.beginMerging(claim.sessionId, claim.expectedSha)) {
      return { result: "waiting", reason: "the request was resolved by something else" };
    }

    // req 4 — the LAST read of the grant, in the instant before the irreversible
    // call. The one above it was taken before a GitHub round trip. This cannot
    // be made atomic with the merge — the residual window is the REST call
    // itself, which no design can recall — but it is the whole of what is left.
    if (!isStillGranted(deps, claim)) {
      deps.claims.releaseUnmerged(claim.sessionId, claim.expectedSha);
      notify(
        deps, claim,
        `The permission to merge in ${target.owner}/${target.repo} was withdrawn, so ShipIt did not `
        + `merge pull request #${claim.prNumber}.`,
        "info",
      );
      return { result: "ended", reason: "the permission was withdrawn" };
    }

    // A THROW here is `indeterminate`, not a failure: the manager's wrapper
    // reads the pull request before it sends the merge, so a rejection can come
    // from either — and the second one can reject after GitHub accepted it. The
    // shape of an error never decides whether something merged.
    let attempt: MergeAttempt;
    try {
      attempt = await deps.githubAuthManager.mergePullRequestAttempt(
        target.owner, target.repo, claim.prNumber, claim.method, claim.expectedSha,
      );
    } catch (err) {
      attempt = { outcome: "indeterminate", message: err instanceof Error ? err.message : String(err) };
    }

    if (attempt.outcome === "indeterminate") {
      // The row stays `merging` on purpose: the merge may have happened, and
      // reconciliation answers that from the tuple rather than from the error.
      notify(
        deps, claim,
        `ShipIt could not tell whether pull request #${claim.prNumber} merged: ${attempt.message} It `
        + "is checking, and will say so here once it knows.",
        "warn",
      );
      return { result: "ended", reason: "indeterminate" };
    }
    if (attempt.outcome === "refused") {
      deps.claims.releaseUnmerged(claim.sessionId, claim.expectedSha);
      notify(
        deps, claim,
        `Did not merge pull request #${claim.prNumber}: ${attempt.message}`,
        "warn",
      );
      return { result: "ended", reason: attempt.message };
    }

    return (await settle(deps, claim, true)) ? { result: "merged" } : { result: "waiting", reason: "settling" };
  } finally {
    deps.claims.clearMergeInFlight(claim.sessionId);
    // RE-RESOLVED, not the one captured above: a session with no container has
    // no runner to hold, and activating it during the call creates one — seeded
    // held from the mark cleared just now, so it is this that unwedges it.
    const held = deps.runnerRegistry?.get(claim.sessionId) ?? runner;
    if (held) {
      held.mergeHold = false;
      // Draining is event-driven, and a background merge has no owning turn
      // whose completion would drain the queue — so a message that arrived
      // under the hold would sit there indefinitely (req 6, last sentence).
      releaseQueuedTurn(held);
    }
  }
}

/**
 * Hand the row to docs/287's settlement. `witnessed` decides what the record may
 * SAY, exactly as it does there: ShipIt merged it, or that commit is now merged.
 *
 * No turn token, deliberately: `settleAgentMerge` compares one only against a
 * turn that is currently running, and the merge path holds the session idle.
 */
async function settle(
  deps: AgentMergeExecutorDeps,
  claim: AgentMergeClaim,
  witnessed: boolean,
): Promise<boolean> {
  // Settlement resolves an ATTEMPT, so the row has to leave `pending` first. The
  // unwitnessed case gets here because somebody else merged the armed commit;
  // promoting the row is what lets reconciliation finish the job from the tuple
  // if this settlement cannot. A no-op when the merge path already promoted it.
  deps.claims.beginMerging(claim.sessionId, claim.expectedSha);
  if (witnessed) deps.claims.markSettling(claim.sessionId, claim.expectedSha);
  const live = deps.claims.get(claim.sessionId);
  if (live?.expectedSha !== claim.expectedSha) return true;
  const outcome = await settleAgentMerge(
    {
      claims: deps.claims,
      sessionManager: deps.sessionManager,
      chatHistoryManager: deps.chatHistoryManager,
      ...(deps.prStatusPoller ? { prStatusPoller: deps.prStatusPoller } : {}),
      ...(deps.runnerRegistry ? { runnerRegistry: deps.runnerRegistry } : {}),
    },
    live,
    {
      witnessed,
      turn: null,
      // Re-asked past the settlement's own GitHub read, and it is what the
      // UNWITNESSED path relies on: that one runs outside the hold, so a turn
      // can start while GitHub is answering and settlement writes session state.
      // The witnessed path holds the session, and passing it there costs nothing.
      stillSafeToSettle: () => isIdle(deps, claim.sessionId, { underHold: witnessed }),
    },
  );
  return outcome.result === "settled";
}

/** End a request that will not be carried out, and say why in the transcript. */
function end(
  deps: AgentMergeExecutorDeps,
  claim: AgentMergeClaim,
  message: string,
): RequestOutcome {
  unreadableCounts.delete(unreadableKey(claim));
  // Only `pending`: if something promoted the row while this pass was reading
  // GitHub, that attempt owns it now. The notice is written INSIDE the delete's
  // transaction — req 3 promises the transcript says why, and "delete, then
  // append" loses the explanation for good if anything fails in between.
  if (!deps.claims.releasePending(
    claim.sessionId, claim.expectedSha, () => notify(deps, claim, message, "info"),
  )) {
    return { result: "waiting", reason: "the request was resolved by something else" };
  }
  return { result: "ended", reason: message };
}

/**
 * req 4 — read from the CLAIM's repository, which the caller has established is
 * the session's own. `allowsAgentMerge` matches on `repoId`, so any spelling of
 * the same repository answers the same.
 */
function isStillGranted(deps: AgentMergeExecutorDeps, claim: AgentMergeClaim): boolean {
  const session = deps.sessionManager.get(claim.sessionId);
  if (!session) return false;
  if (repoId(session.remoteUrl ?? "") !== claim.repoId) return false;
  return mergeDisposition(session, deps.repoStore.allowsAgentMerge(session.remoteUrl ?? "")) === "allowed";
}

/** Consecutive unreadable reads, per request. Cleared by any answer at all. */
const unreadableCounts = new Map<string, number>();
const UNREADABLE_LIMIT = 15;

function unreadableKey(claim: AgentMergeClaim): string {
  return `${claim.sessionId}@${claim.expectedSha}`;
}

/** Unattached: this runs post-turn, and often with no runner to emit through. */
function notify(
  deps: AgentMergeExecutorDeps,
  claim: AgentMergeClaim,
  message: string,
  level: "info" | "warn",
): void {
  persistNoticeUnattached(deps.chatHistoryManager, claim.sessionId, message, level);
}

/**
 * req 6 — is the session doing anything a merge must not overlap? A queued
 * message counts: draining it starts a turn, and the point is that the turn and
 * the merge do not overlap in either order.
 */
function isIdle(
  deps: AgentMergeExecutorDeps,
  sessionId: string,
  opts: { underHold?: boolean } = {},
): boolean {
  const runner = deps.runnerRegistry?.get(sessionId);
  // No runner is genuinely idle: a session with no container is not mid-turn.
  if (!runner) return true;
  if (runner.running || runner.agentBusy || runner.systemTurnInProgress) return false;
  if (runner.queueLength > 0) return false;
  // The hold this pass just took is its own, not somebody else's.
  return opts.underHold === true || !runner.mergeHold;
}
