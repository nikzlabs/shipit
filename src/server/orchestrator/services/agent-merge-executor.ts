import type { SessionManager } from "../sessions.js";
import type { RepoStore } from "../repo-store.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { ChatHistoryManager } from "../chat-history.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { MergeAttempt } from "../github-auth-prs.js";
import type { AgentMergeClaim, AgentMergeClaimStore } from "../agent-merge-claims.js";
import {
  persistNoticeUnattached, emitNoticePostTurn, emitNoticeInTurn, buildSystemNotice, turnRowsFinalized,
} from "../chat-card-persistence.js";
import { ownerRepoFromRepoId, repoId } from "../git-utils.js";
import { mergeDisposition } from "../pr-target.js";
import {
  describeBackgroundWork, githubRefusalClearsByItself, readMergeObservation,
} from "./merge-gate.js";
import { settleAgentMerge, reconcileAgentMergeClaims } from "./agent-merge-settlement.js";
import { releaseQueuedTurn } from "../queue-drain.js";
import { unprobedAfterRestart } from "../restart-turn-reattach.js";

export interface AgentMergeExecutorDeps {
  claims: AgentMergeClaimStore;
  sessionManager: SessionManager;
  chatHistoryManager: ChatHistoryManager;
  repoStore: Pick<RepoStore, "allowsAgentMerge">;
  githubAuthManager: GitHubAuthManager;
  prStatusPoller?: PrStatusPoller;
  runnerRegistry?: SessionRunnerRegistry;
}

export type RequestOutcome =
  | { result: "waiting"; reason: string }
  | { result: "merged" }
  | { result: "ended"; reason: string };

const TICK_MS = 20_000;

export class AgentMergeExecutor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: AgentMergeExecutorDeps) {}

  /** Start after reattachInFlightTurns so surviving turns are visible to idle checks. */
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

  async tick(): Promise<void> {
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

export async function runAgentMergeRequests(deps: AgentMergeExecutorDeps): Promise<void> {
  // Reconcile attempts too; unattended sessions may receive no other retry trigger.
  const before = deps.claims.list();
  await reconcileAgentMergeClaims({
    claims: deps.claims,
    sessionManager: deps.sessionManager,
    chatHistoryManager: deps.chatHistoryManager,
    ...(deps.prStatusPoller ? { prStatusPoller: deps.prStatusPoller } : {}),
    ...(deps.runnerRegistry ? { runnerRegistry: deps.runnerRegistry } : {}),
  }).catch((err: unknown) => {
    console.error("[agent-merge] reconciling stranded attempts failed:", err);
  });
  reportStuckAttempts(deps, before);

  const pending = deps.claims.listPending();
  for (const sessionId of waits.keys()) {
    if (!pending.some((claim) => claim.sessionId === sessionId)) waits.delete(sessionId);
  }

  for (const claim of pending) {
    try {
      const outcome = await runOneRequest(deps, claim);
      if (outcome.result === "waiting") {
        logWaitOnce(claim, outcome.reason);
      } else {
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
    deps.claims.releasePending(claim);
    return { result: "ended", reason: "the session is gone" };
  }

  // A repointed session must not use its new repository's permission for this claim.
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

  if (!isStillGranted(deps, claim)) {
    return end(
      deps, claim,
      `The permission to merge in ${target.owner}/${target.repo} was withdrawn, so ShipIt did not `
      + `merge pull request #${claim.prNumber}.`,
    );
  }

  const blocker = idleBlocker(deps, claim.sessionId);
  if (blocker) {
    noteHold(deps, claim, blocker);
    return { result: "waiting", reason: `the session is not idle: ${blocker.why}` };
  }
  waitState(claim).heldSince = null;

  const observation = await readMergeObservation(
    deps.githubAuthManager, target.owner, target.repo, claim.prNumber,
  );
  if (observation.kind === "unreadable") {
    // Bound consecutive read failures; a process restart resets the count.
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
  unreadableCounts.delete(unreadableKey(claim));

  if (observation.headRefOid !== claim.expectedSha) {
    return end(
      deps, claim,
      `Cancelled the merge request for pull request #${claim.prNumber}: the branch has moved past `
      + `${claim.expectedSha.slice(0, 8)}, the commit ShipIt was asked to merge. Nothing was merged. `
      + "Ask again to merge the new commit.",
    );
  }

  if (observation.prState === "MERGED") {
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
  // A stale rollup must neither approve nor cancel checks for the requested commit.
  if (observation.rollupCommitOid !== observation.headRefOid) {
    return { result: "waiting", reason: "the checks for this commit have not reported" };
  }

  if (observation.rollupState === "FAILURE" || observation.rollupState === "ERROR") {
    return end(
      deps, claim,
      `Cancelled the merge request for pull request #${claim.prNumber}: its checks failed at `
      + `${claim.expectedSha.slice(0, 8)}. Fix CI and push; ShipIt does not wait for a re-run of a `
      + "commit that has already failed.",
    );
  }
  if (observation.reviewDecision !== null && observation.reviewDecision !== "APPROVED") {
    return end(
      deps, claim,
      `Cancelled the merge request for pull request #${claim.prNumber}: GitHub reports it needs `
      + `review (${observation.reviewDecision}). Ask again once it is approved.`,
    );
  }

  if (observation.rollupState === "PENDING" || observation.rollupState === "EXPECTED") {
    return { result: "waiting", reason: "checks are running" };
  }

  if (observation.rollupState === null) {
    // Allow workflows time to register before treating zero checks as no CI.
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

async function performMerge(
  deps: AgentMergeExecutorDeps,
  claim: AgentMergeClaim,
  target: { owner: string; repo: string },
): Promise<RequestOutcome> {
  // The reads were awaited: a turn can start and end inside one, and leave work running.
  // Nothing is awaited from here to the merge call, so this answer still holds there.
  const blocker = idleBlocker(deps, claim.sessionId);
  if (blocker) return { result: "waiting", reason: `the session is not idle: ${blocker.why}` };

  const runner = deps.runnerRegistry?.get(claim.sessionId);
  // The store mark blocks reconciliation without a runner and seeds newly created runners.
  deps.claims.markMergeInFlight(claim.sessionId);
  if (runner) runner.mergeHold = true;
  let leased = false;
  try {
    // Prevent disposal as well as turn admission. Take the lease after the idle
    // check because the lease itself makes agentBusy true.
    if (runner) {
      runner.beginPostTurnWork();
      leased = true;
    }
    // Persist the attempt before sending: GitHub may accept a request whose response is lost.
    if (!deps.claims.beginMerging(claim)) {
      return { result: "waiting", reason: "the request was resolved by something else" };
    }

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

    // A thrown error does not prove that GitHub refused the merge.
    let attempt: MergeAttempt;
    try {
      attempt = await deps.githubAuthManager.mergePullRequestAttempt(
        target.owner, target.repo, claim.prNumber, claim.method, claim.expectedSha,
        // Recheck permission after the wrapper's GET, immediately before its PUT.
        () => (isStillGranted(deps, claim)
          ? null
          : `The permission to merge in ${target.owner}/${target.repo} was withdrawn, so ShipIt `
            + `did not merge pull request #${claim.prNumber}.`),
      );
    } catch (err) {
      attempt = { outcome: "indeterminate", message: err instanceof Error ? err.message : String(err) };
    }

    // A required check GitHub expects is a check that has not passed yet (req 1).
    if (
      attempt.outcome === "refused"
      && githubRefusalClearsByItself(attempt.message)
      && deps.claims.returnToPending(claim)
    ) {
      noteNotYetRefusal(deps, claim, attempt.message);
      return { result: "waiting", reason: attempt.message };
    }
    notYetRefusals.delete(claim.sessionId);

    if (attempt.outcome === "indeterminate") {
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
    // Release the original lease, then any hold inherited by a newly created runner.
    if (leased) runner?.endPostTurnWork();
    const held = deps.runnerRegistry?.get(claim.sessionId) ?? runner;
    if (held) {
      if (held !== runner) held.endPostTurnWork();
      held.mergeHold = false;
      // No owning turn will finish and drain messages queued under this hold.
      releaseQueuedTurn(held);
    }
  }
}

async function settle(
  deps: AgentMergeExecutorDeps,
  claim: AgentMergeClaim,
  witnessed: boolean,
): Promise<boolean> {
  // Promote even unwitnessed merges so reconciliation can finish a failed settlement.
  deps.claims.beginMerging(claim);
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
      // Unwitnessed settlement has no hold; recheck after its GitHub read.
      stillSafeToSettle: () => isIdle(deps, claim.sessionId, { underHold: witnessed }),
    },
  );
  return outcome.result === "settled";
}

function end(
  deps: AgentMergeExecutorDeps,
  claim: AgentMergeClaim,
  message: string,
): RequestOutcome {
  unreadableCounts.delete(unreadableKey(claim));
  notYetRefusals.delete(claim.sessionId);
  // Delete only pending claims, in the same transaction that persists the notice.
  const notice = splitNotice(deps, claim, message);
  if (!deps.claims.releasePending(claim, notice.persist)) {
    return { result: "waiting", reason: "the request was resolved by something else" };
  }
  notice.announce();
  return { result: "ended", reason: message };
}

function isStillGranted(deps: AgentMergeExecutorDeps, claim: AgentMergeClaim): boolean {
  // Re-granting permission must not revive a request cancelled during this attempt.
  if (deps.claims.isMergeCancelled(claim.sessionId)) return false;
  const session = deps.sessionManager.get(claim.sessionId);
  if (!session) return false;
  if (repoId(session.remoteUrl ?? "") !== claim.repoId) return false;
  return mergeDisposition(session, deps.repoStore.allowsAgentMerge(session.remoteUrl ?? "")) === "allowed";
}

// Report unresolved attempts once, but retain their evidence and block further merges.
function reportStuckAttempts(deps: AgentMergeExecutorDeps, before: AgentMergeClaim[]): void {
  for (const claim of before) {
    if (claim.origin !== "auto") continue;
    const key = unreadableKey(claim);
    const still = deps.claims.get(claim.sessionId);
    if (still?.expectedSha !== claim.expectedSha) {
      stuckAttempts.delete(key);
      continue;
    }
    const passes = (stuckAttempts.get(key) ?? 0) + 1;
    stuckAttempts.set(key, passes);
    if (passes !== UNREADABLE_LIMIT) continue;
    persistNoticeUnattached(
      deps.chatHistoryManager, claim.sessionId,
      `ShipIt still cannot tell whether pull request #${claim.prNumber} merged at `
      + `${claim.expectedSha.slice(0, 8)}, after ${passes} attempts. It keeps the record and will `
      + "keep trying, but no further merge will start on this session until this resolves. Check "
      + "the pull request on GitHub, and that ShipIt still has access to the repository.",
      "warn",
    );
  }
}

const stuckAttempts = new Map<string, number>();

const unreadableCounts = new Map<string, number>();
const UNREADABLE_LIMIT = 15;

function unreadableKey(claim: AgentMergeClaim): string {
  return `${claim.sessionId}@${claim.expectedSha}`;
}

// Keep waiting, but say so once: branch protection can name a check that never runs.
// Keyed by the row's creation too, so a request armed again at the same commit starts over.
const notYetRefusals = new Map<string, { request: string; count: number }>();

function noteNotYetRefusal(deps: AgentMergeExecutorDeps, claim: AgentMergeClaim, message: string): void {
  const request = `${claim.expectedSha}@${claim.createdAt}`;
  const prev = notYetRefusals.get(claim.sessionId);
  const count = prev?.request === request ? prev.count + 1 : 1;
  notYetRefusals.set(claim.sessionId, { request, count });
  if (count !== UNREADABLE_LIMIT) return;
  notify(
    deps, claim,
    `GitHub still refuses to merge pull request #${claim.prNumber}, after ${count} attempts: ${message} `
    + "ShipIt keeps the request and merges when GitHub allows it. If that check never starts, the "
    + "repository's branch protection requires a check that nothing reports.",
    "warn",
  );
}

function notify(
  deps: AgentMergeExecutorDeps,
  claim: AgentMergeClaim,
  message: string,
  level: "info" | "warn",
): void {
  const runner = deps.runnerRegistry?.get(claim.sessionId);
  if (!runner) {
    persistNoticeUnattached(deps.chatHistoryManager, claim.sessionId, message, level);
    return;
  }
  emitNoticePostTurn(
    (m) => runner.emitMessage(m), deps.chatHistoryManager, claim.sessionId, message, level,
  );
}

// Persist inside the delete transaction; announce after commit, with the same noticeId.
function splitNotice(deps: AgentMergeExecutorDeps, claim: AgentMergeClaim, message: string) {
  const { ws, persisted } = buildSystemNotice(claim.sessionId, message, "info");
  return {
    persist: (): void => { deps.chatHistoryManager.append(claim.sessionId, persisted); },
    announce: (): void => { deps.runnerRegistry?.get(claim.sessionId)?.emitMessage(ws); },
  };
}

interface IdleBlocker {
  /** Completes "…, and <why>" in a notice. It is also logged, so it carries no agent text. */
  why: string;
  work?: string[];
  /** Set while a turn runs. Epochs start again on a new runner, so the pair names the turn. */
  turn?: HoldingTurn;
}

interface HoldingTurn {
  runner: object;
  epoch: number;
}

function idleBlocker(deps: AgentMergeExecutorDeps, sessionId: string): IdleBlocker | null {
  const runner = deps.runnerRegistry?.get(sessionId);
  if (!runner) {
    // A failed startup probe can hide a surviving turn despite an absent runner.
    return unprobedAfterRestart.has(sessionId)
      ? { why: "ShipIt restarted and has not confirmed that this session's last turn ended" }
      : null;
  }
  unprobedAfterRestart.delete(sessionId);
  if (runner.running) return { why: "a turn is running", turn: { runner, epoch: runner.turnEpoch ?? 0 } };
  if (runner.systemTurnInProgress) return { why: "ShipIt is working on this session's branch" };
  if (runner.agentBusy) {
    // Background work normally ends by starting a turn that no hold can keep back (docs/288-agent-merge-arming req 6).
    const work = runner.backgroundWorkDescriptions;
    return work.length > 0
      ? { why: `background work is still running (${work.length})`, work }
      : { why: "ShipIt still has work in progress on this session (a commit, a push or an install)" };
  }
  if (runner.queueLength > 0) return { why: "a queued message is waiting to start" };
  if (runner.mergeHold) return { why: "another merge is in progress" };
  return null;
}

function isIdle(
  deps: AgentMergeExecutorDeps,
  sessionId: string,
  opts: { underHold?: boolean } = {},
): boolean {
  if (opts.underHold !== true) return idleBlocker(deps, sessionId) === null;
  const runner = deps.runnerRegistry?.get(sessionId);
  if (!runner) return !unprobedAfterRestart.has(sessionId);
  unprobedAfterRestart.delete(sessionId);
  // Under our hold, ignore our own lease and messages queued behind the merge.
  return !runner.running && !runner.systemTurnInProgress;
}

interface WaitState {
  request: string;
  logged: string | null;
  heldSince: number | null;
  /** The turn that holds the request, or null when no turn runs. */
  heldByTurn: HoldingTurn | null;
  announced: boolean;
}

// A session holds at most one request, and a request armed again starts over.
const waits = new Map<string, WaitState>();

function waitState(claim: AgentMergeClaim): WaitState {
  const request = `${claim.prNumber}@${claim.expectedSha}@${claim.createdAt}`;
  let state = waits.get(claim.sessionId);
  if (state?.request !== request) {
    state = { request, logged: null, heldSince: null, heldByTurn: null, announced: false };
    waits.set(claim.sessionId, state);
  }
  return state;
}

function logWaitOnce(claim: AgentMergeClaim, reason: string): void {
  const state = waitState(claim);
  if (state.logged === reason) return;
  state.logged = reason;
  console.log(`[agent-merge] request ${claim.sessionId} PR #${claim.prNumber}: waiting — ${reason}`);
}

// Longer than the commit and push that follow every turn, which hold the session too.
const HOLD_NOTICE_AFTER_MS = 120_000;
// A turn that asks for the merge usually ends soon after; only one that goes on is news.
const TURN_HOLD_NOTICE_AFTER_MS = 600_000;

/** Say once per request what holds it, after the hold has lasted longer than the usual one. */
function noteHold(deps: AgentMergeExecutorDeps, claim: AgentMergeClaim, blocker: IdleBlocker): void {
  const state = waitState(claim);
  const now = Date.now();
  const turn = blocker.turn ?? null;
  // The count is for one turn, or for the time with no turn: the commit and push after a long
  // turn are not announced, and a turn that has just started is not either.
  const sameHold = state.heldByTurn?.runner === turn?.runner && state.heldByTurn?.epoch === turn?.epoch;
  if (state.heldSince === null || !sameHold) {
    state.heldSince = now;
    state.heldByTurn = turn;
  }
  const delay = turn === null ? HOLD_NOTICE_AFTER_MS : TURN_HOLD_NOTICE_AFTER_MS;
  if (state.announced || now - state.heldSince < delay) return;
  const why = blocker.work
    ? `background work is still running (${describeBackgroundWork(blocker.work)})`
    : blocker.why;
  const message = `ShipIt has not merged pull request #${claim.prNumber}: it merges on request only while this `
    + `session is idle, and ${why}. The request stays armed — ShipIt merges once the session is idle `
    + "and the checks have passed.";
  const runner = turn === null ? undefined : deps.runnerRegistry?.get(claim.sessionId);
  // A turn that has not started its rows yet takes the notice as a final row, like no turn.
  if (runner && !turnRowsFinalized(runner)) {
    const recorded = runner.recordedCards;
    try {
      // The turn rebuilds its rows from the runner, so the notice is recorded there.
      emitNoticeInTurn(runner, claim.sessionId, message, deps.chatHistoryManager);
    } catch (err) {
      // A notice already on the runner is written with the turn's next rows; another would double it.
      if (runner.recordedCards !== recorded) state.announced = true;
      throw err;
    }
    state.announced = true;
    return;
  }
  const notice = splitNotice(deps, claim, message);
  // A write that fails is tried again on the next pass, and nothing shows that history lacks.
  notice.persist();
  state.announced = true;
  notice.announce();
}
