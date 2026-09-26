import { randomUUID } from "node:crypto";
import type { GitManager, RebaseConflictFile } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { AgentProcess, AgentId, BranchSyncedCard } from "../../shared/types.js";
import type { ChatHistoryManager } from "../chat-history.js";
import type { SessionManager } from "../sessions.js";
import type { UsageManager } from "../usage.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import { residentBackgroundWork } from "../turn-admission.js";
import { ServiceError } from "./types.js";
import { agentLogAppend } from "../log-emit.js";
import { emitNoticePostTurn } from "../chat-card-persistence.js";
import { releaseQueuedTurn } from "../queue-drain.js";
import {
  classifyPushFailure,
  formatPathList,
  isNonFastForwardError,
  summarizeGitError,
  untrackedOverwritePaths,
} from "./git.js";
import { findSharedBranchRefusal } from "./push-target-guard.js";
import { withWorkspaceLock } from "./marketplace.js";
import { getErrorMessage } from "../validation.js";
import { handWorkspaceBackToWorker } from "../session-worker-uid.js";
import { restoreLfsAfterTreeRewrite } from "../git-lfs.js";
import {
  AUTO_RESOLVE_DEFER_BACKGROUND_WORK,
  type AutoResolveResult,
} from "../auto-conflict-resolve-manager.js";
import { prepareDispatch } from "../prepared-dispatch.js";
import { onWorkspaceRewritten } from "../workspace-rewrite.js";
import {
  closeFollowupWindow,
  deliverRebaseFollowup,
  openFollowupWindow,
  type RebaseFollowup,
} from "./rebase-followup.js";

export const MAX_REBASE_ITERATIONS = 10;

export interface RebaseDriverDeps {
  git: GitManager;
  githubAuthManager: GitHubAuthManager;
  runner: SessionRunnerInterface;
  sessionManager: SessionManager;
  chatHistoryManager: ChatHistoryManager;
  usageManager: UsageManager;
  agentFactory?: (agentId: AgentId) => AgentProcess;
  sseBroadcast: (event: string, data: unknown) => void;
  /** Marks the dispatch boundary for automatic attempt accounting. */
  onAgentSpawned?: () => void;
  /** The auto-resolve deadline closes the window itself; a hanging turn never reaches `finally`. */
  onFollowupWindowOpened?: (attemptId: string) => void;
  drainQueue?: () => Promise<void> | void;
  /** Manual sync: persist no-op confirmations and notify the agent of rewrites. */
  recordSyncCard?: boolean;
  prStatusPoller?: RebasePrStatusPoller | null;
  /** Manual sync only. Hand over the push arm before later commit bookkeeping can throw. */
  commitPendingWork?: (
    deferPushArm: (arm: () => void) => void,
  ) => Promise<{ commitHash: string | null }>;
}

export interface RebasePrStatusPoller {
  notifyAutoPush(sessionId: string): void;
  forceRefreshSession(sessionId: string): Promise<void>;
}

export type RebaseFlowOutcome =
  | { status: "up_to_date"; forcePushed: boolean }
  | { status: "rebased"; forcePushed: boolean }
  | {
    status: "conflicts_resolved";
    iterations: number;
    forcePushed: boolean;
    /** Present only when the agent armed a note during conflict resolution. */
    followup?: RebaseFollowup;
  }
  | { status: "aborted"; reason: string };

export function buildRebaseConflictPrompt(
  baseBranch: string,
  conflicts: RebaseConflictFile[],
): string {
  const fileList = conflicts.map((c) => `- \`${c.path}\``).join("\n");
  return [
    `Rebasing onto \`${baseBranch}\` — ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"} to resolve:`,
    fileList,
    "",
    "Each file has standard git conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`).",
    "Edit them to produce the correct merged result. Don't run any git commands —",
    "just edit the files. After you finish, the orchestrator will stage your changes",
    "and continue the rebase.",
    "",
    "This turn ends BEFORE the rebase does. If finishing the job properly needs work once the",
    "rebase concludes — re-running codegen or the tests over the merged result, fixing a",
    "semantic conflict the markers do not show, updating the PR body — arm it now, in this turn:",
    "",
    '  shipit session continue-after-rebase --note "<what to do once the rebase lands>"',
    "",
    "ShipIt gives that note back to you as a turn once the rebase concludes. Arm nothing if the",
    "resolved files are the whole job.",
  ].join("\n");
}

interface LocalBaseMove {
  from: string | null;
  to: string;
}

// Fetch advances only the remote-tracking ref; local base comparisons need this move.
async function syncLocalBaseRef(git: GitManager, baseBranch: string): Promise<LocalBaseMove | null> {
  try {
    const to = await git.getRefHash(`origin/${baseBranch}`);
    if (!to) return null;
    const from = await git.getRefHash(baseBranch);
    if (from === to) return { from, to };
    const current = await git.getCurrentBranch();
    if (current !== baseBranch) {
      await git.forceUpdateBranchRef(baseBranch, `origin/${baseBranch}`);
    }
    return { from, to };
  } catch (err) {
    console.error("[rebase] local base ref sync failed:", getErrorMessage(err));
    return null;
  }
}

// Resolution turns are finalized before this card is appended to history.
function emitSyncCard(
  deps: RebaseDriverDeps,
  opts: { baseBranch: string; headFrom: string | null; headTo: string | null; baseMove: LocalBaseMove | null; forcePushed: boolean },
): boolean {
  const { runner, chatHistoryManager } = deps;
  const card: BranchSyncedCard = {
    cardId: `sync-${randomUUID()}`,
    base: opts.baseBranch,
    headFromSha: opts.headFrom ?? "",
    headToSha: opts.headTo ?? "",
    baseFromSha: opts.baseMove?.from ?? null,
    baseToSha: opts.baseMove?.to ?? "",
    forcePushed: opts.forcePushed,
    createdAt: new Date().toISOString(),
  };
  try {
    chatHistoryManager.append(runner.sessionId, { role: "assistant", text: "", branchSynced: card });
    runner.emitMessage({ type: "branch_synced_card", sessionId: runner.sessionId, card });
    return true;
  } catch (err) {
    console.error("[rebase] emitting the branch-synced card failed:", getErrorMessage(err));
    return false;
  }
}

function recordAgentNotice(
  deps: RebaseDriverDeps,
  opts: { baseBranch: string; headFrom: string | null; headTo: string | null; forcePushed: boolean; resolvedConflicts: boolean },
): void {
  try {
    deps.sessionManager.setPendingAgentNotice(
      deps.runner.sessionId,
      buildBranchSyncAgentNotice(opts),
    );
  } catch (err) {
    console.error("[rebase] recording the agent sync notice failed:", getErrorMessage(err));
  }
}

export function buildBranchSyncAgentNotice(opts: {
  baseBranch: string;
  headFrom: string | null;
  headTo: string | null;
  forcePushed: boolean;
  resolvedConflicts: boolean;
}): string {
  const shas = opts.headFrom && opts.headTo
    ? ` (was ${opts.headFrom.slice(0, 7)} → now ${opts.headTo.slice(0, 7)})`
    : "";
  const conflicts = opts.resolvedConflicts ? ", resolving conflicts along the way" : "";
  const pushed = opts.forcePushed ? " and force-pushed" : "";
  return (
    `[System] While you were idle, this branch was rebased onto the latest `
    + `origin/${opts.baseBranch}${shas}${conflicts}${pushed}. Your working tree was `
    + `rewritten from outside the session: files you read earlier in this conversation `
    + `may have changed, and commit SHAs you noted are stale. Re-read any file before `
    + `editing it rather than relying on an earlier read, and do not try to undo the `
    + `sync or re-apply anything it brought in.`
  );
}

const MID_REBASE_TEXT =
  "Aborting the rebase FAILED — the workspace is still mid-rebase; run `git rebase --abort` to recover.";

/** What a failed sync left behind, when that is not a clean abort; `null` means git could not say. */
export function rebaseLeftoverText(rebaseInProgress: boolean | null): string | null {
  if (rebaseInProgress === false) return null;
  return rebaseInProgress
    ? MID_REBASE_TEXT
    : "ShipIt could not check whether the rebase was aborted; run `git status` in the terminal, and "
      + "`git rebase --abort` if a rebase is still in progress.";
}

/** The chat notice for a manual sync failure the flow did not explain itself. */
export function buildSyncFailureNotice(
  baseBranch: string,
  errorMessage: string,
  rebaseInProgress: boolean | null,
): string {
  const leftover = rebaseLeftoverText(rebaseInProgress);
  const paths = untrackedOverwritePaths(errorMessage);
  if (paths && paths.length > 0) {
    return `Sync with \`${baseBranch}\` failed: a commit being replayed adds files at paths where this `
      + "workspace already has untracked files, and git will not overwrite them. These are usually files "
      + `this branch ignores but \`${baseBranch}\` does not, such as build caches: ${formatPathList(paths)}. `
      + `${leftover ?? "Your branch was not changed by ShipIt."} To sync, delete those `
      + "files if they can be regenerated, squash this branch so the commit that adds them and the later one "
      + `that stops tracking them cancel out, or add the ignore rule to \`${baseBranch}\` first.`;
  }
  const summary = summarizeGitError(errorMessage).replace(/[.:]$/, "");
  const state = leftover ?? "Your branch was not changed by ShipIt; check the workspace state and try again.";
  return `Sync with \`${baseBranch}\` failed: ${summary}. ${state}`;
}

// The container's file watcher may miss a rewrite from the orchestrator.
function reevaluateSessionAfterRewrite(runner: SessionRunnerInterface): void {
  onWorkspaceRewritten(runner, "rebase");
}

/**
 * Between resolution turns, and from the last one through the force-push and the
 * branch-synced card, `running` is false — so only this lease keeps the runner out of
 * the idle enforcer's reach. It feeds `agentBusy` and the non-forced `dispose()` guards
 * from one flag, which is what CLAUDE.md's post-turn invariant 5 asks of post-turn-shaped
 * work (planning#556). It is dropped while a resolution turn runs, where `running`
 * guards instead.
 *
 * `take()` re-arms at every segment boundary rather than holding once: POST_TURN_HOLD_MAX_MS
 * caps a hold at 120s, and `PostTurnHold` counts depth with no per-holder identity — past
 * the deadline `begin()` zeroes the count, so neither our flag nor the aggregate proves we
 * still contribute one. The cover is therefore bounded: a SINGLE segment that outruns the
 * deadline reads idle again until the next boundary.
 */
class RebaseRunnerHold {
  private held = false;
  constructor(private readonly runner: SessionRunnerInterface) {}
  take(): void {
    if (this.held && this.runner.postTurnWorkInFlight) return;
    this.held = true;
    this.runner.beginPostTurnWork();
  }
  release(): void {
    if (!this.held) return;
    this.held = false;
    this.runner.endPostTurnWork();
  }
}

/**
 * The driver's own claim on `runner.systemTurnInProgress`, separate from the disposal lease
 * above: every write of `true` mints a new `systemHoldSeq`, and the release compares (docs/304).
 */
interface SystemHoldTicket { seq: number }

/** One entry point, so no acquisition can forget to capture the ticket it releases on. */
function takeSystemHold(runner: SessionRunnerInterface, ticket: SystemHoldTicket): void {
  runner.systemTurnInProgress = true;
  ticket.seq = runner.systemHoldSeq;
}

// The runner is no longer running; hold it against disposal during restoration.
async function restoreLfsForSync(deps: RebaseDriverDeps, baseBranch: string): Promise<void> {
  const { runner } = deps;
  runner.beginPostTurnWork();
  try {
    await restoreLfsAfterTreeRewrite(runner.sessionDir, `Sync with ${baseBranch}`, (message) =>
      deps.sseBroadcast("error", { message }),
    );
  } finally {
    runner.endPostTurnWork();
  }
}

// HTTP 409 defers automatic resolution without consuming an attempt.
function refuseSync(deps: RebaseDriverDeps, baseBranch: string, reason: string): ServiceError {
  const message = `Sync with \`${baseBranch}\` did not start — ${reason}`;
  const explained = persistSyncNotice(deps, message);
  const err = new ServiceError(409, message);
  return explained ? markSyncFailureExplained(err) : err;
}

/**
 * The automatic path retries the same interruption on a timer, so an identical warning per
 * retry is noise rather than information (nikzlabs/shipit#2751). Keyed by runner object so
 * the entry dies with the session and a re-created runner reports afresh.
 */
const lastAbortNotice = new WeakMap<SessionRunnerInterface, string>();

// Returns whether the failure is explained in the transcript, not whether it wrote a row.
function persistAbortNotice(deps: RebaseDriverDeps, message: string): boolean {
  const { runner } = deps;
  // A manual sync is one deliberate click; it always gets its own answer.
  const dedupe = !deps.recordSyncCard;
  if (dedupe && lastAbortNotice.get(runner) === message) return true;
  try {
    emitNoticePostTurn(
      (m) => runner.emitMessage(m),
      deps.chatHistoryManager,
      runner.sessionId,
      message,
      "warn",
    );
  } catch (err) {
    console.error("[rebase] abort notice failed:", getErrorMessage(err));
    return false;
  }
  if (dedupe) lastAbortNotice.set(runner, message);
  return true;
}

function persistSyncNotice(deps: RebaseDriverDeps, message: string): boolean {
  if (!deps.recordSyncCard) return false;
  try {
    emitNoticePostTurn(
      (m) => deps.runner.emitMessage(m),
      deps.chatHistoryManager,
      deps.runner.sessionId,
      message,
      "warn",
    );
    return true;
  } catch (err) {
    console.error("[rebase] sync notice failed:", getErrorMessage(err));
    return false;
  }
}

// Prevent duplicate notices without wrapping the error and changing its classification.
const SYNC_FAILURE_EXPLAINED = Symbol("shipit.syncFailureExplained");

export function markSyncFailureExplained<T>(err: T): T {
  if (err !== null && typeof err === "object") {
    Object.defineProperty(err, SYNC_FAILURE_EXPLAINED, { value: true, enumerable: false });
  }
  return err;
}

export function syncFailureAlreadyExplained(err: unknown): boolean {
  return (
    err !== null
    && typeof err === "object"
    && (err as Record<symbol, unknown>)[SYNC_FAILURE_EXPLAINED] === true
  );
}

function unreadableReason(detail: string): string {
  return (
    `git cannot read \`${detail}\` in this workspace, so a rebase would rewrite the `
    + "working tree over content it cannot see. Fix the permissions on that path, then sync again."
  );
}

// Share the post-turn commit mutex, then recheck under the rebase lock after fetch.
async function prepareWorkspaceForRebase(
  deps: RebaseDriverDeps,
  baseBranch: string,
  deferPushArm: (arm: () => void) => void,
): Promise<{ savedCommit: string | null }> {
  const { git, runner } = deps;
  const inWorkspace = <T>(fn: () => Promise<T>): Promise<T> =>
    withWorkspaceLock(runner.sessionDir, fn);

  if (await inWorkspace(() => git.isRebaseInProgress())) {
    throw refuseSync(
      deps,
      baseBranch,
      "a rebase is already in progress in this workspace. Finish or abort it "
      + "(the Abort button on the rebase banner, or `git rebase --abort` in the terminal), then sync again.",
    );
  }

  let state = await inWorkspace(() => git.inspectWorkingTree());
  if (state.unreadable) throw refuseSync(deps, baseBranch, unreadableReason(state.unreadable.detail));
  if (state.clean) return { savedCommit: null };

  if (!deps.commitPendingWork) {
    throw refuseSync(
      deps,
      baseBranch,
      "this session has uncommitted changes. Nothing was changed; commit or revert them, then sync again.",
    );
  }

  const saved = await deps.commitPendingWork(deferPushArm);
  state = await inWorkspace(() => git.inspectWorkingTree());
  if (state.unreadable || !state.clean) {
    throw refuseSync(
      deps,
      baseBranch,
      state.unreadable
        ? unreadableReason(state.unreadable.detail)
        : "ShipIt could not save this session's uncommitted changes, so the rebase was never "
          + "started and your work is untouched. The notice just above says what the commit was "
          + "refused for — a likely secret in the diff, or unresolved conflict markers. Fix that, then sync again.",
    );
  }
  return { savedCommit: saved.commitHash };
}

export async function runRebaseFlow(
  deps: RebaseDriverDeps,
  baseBranch: string,
): Promise<RebaseFlowOutcome> {
  const { git, runner } = deps;
  const recordSync = deps.recordSyncCard ?? false;
  let worktreeRewritten = false;
  // Any other ending re-arms the notice, so a later recurrence is reported again.
  let abortNoticeReached = false;

  if (runner.running) {
    throw new ServiceError(409, "Cannot rebase while an agent turn is in progress");
  }
  if (runner.systemTurnInProgress) {
    throw new ServiceError(409, "Cannot rebase while a system turn is in progress");
  }

  // Keep user turns queued between resolution turns and through the final push.
  const systemHold: SystemHoldTicket = { seq: 0 };
  takeSystemHold(runner, systemHold);

  // Defer auto-push so it cannot race the force-push. The object avoids TS callback narrowing.
  const pendingPush: { arm: (() => void) | null } = { arm: null };
  // Object-held so the `finally` reads what the conflict loop wrote.
  const followupAttempt: { id: string | null } = { id: null };
  const hold = new RebaseRunnerHold(runner);
  let published = false;
  let pushProhibited = false;
  let savedCommit: string | null = null;

  try {
    hold.take();
    savedCommit = (await prepareWorkspaceForRebase(
      deps,
      baseBranch,
      (arm) => { pendingPush.arm = arm; },
    )).savedCommit;

    await git.fetch("origin");

    const baseRef = await git.resolveBaseBranchRef(baseBranch);
    if (!baseRef) {
      throw new ServiceError(400, `Cannot resolve base branch: ${baseBranch}`);
    }

    const headBefore = await git.getHeadHash();
    const baseMove = await syncLocalBaseRef(git, baseBranch);

    const isAncestor = await git.isAncestor(baseRef, "HEAD");
    if (isAncestor) {
      // GitHub computes mergeability from the pushed head, which may still be behind.
      const pushOutcome = await pushIfAheadOfRemote(deps, baseBranch);
      const forcePushed = pushOutcome === "pushed";
      published = forcePushed;
      pushProhibited = pushOutcome === "refused";
      const cardEmitted = recordSync
        ? emitSyncCard(deps, { baseBranch, headFrom: headBefore, headTo: headBefore, baseMove, forcePushed })
        : false;
      runner.emitMessage({ type: "rebase_complete", sessionId: runner.sessionId, forcePushed, upToDate: true, baseMoved: cardEmitted });
      return { status: "up_to_date", forcePushed };
    }

    runner.emitMessage({ type: "rebase_started", sessionId: runner.sessionId, baseBranch });

    // Inspect and rebase under one lock: editor saves can dirty the tree during fetch.
    let result = await withWorkspaceLock(runner.sessionDir, async () => {
      const state = await git.inspectWorkingTree();
      if (state.unreadable) throw refuseSync(deps, baseBranch, unreadableReason(state.unreadable.detail));
      if (!state.clean) {
        throw refuseSync(
          deps,
          baseBranch,
          "this session's working tree changed while the sync was preparing, so it now has "
          + "uncommitted changes again. Nothing was rebased and your work is untouched — sync again.",
        );
      }
      worktreeRewritten = true;
      return git.rebase(baseRef);
    });

    if (result.status === "clean") {
      // Nothing refreshed the lease since the flow started; fetch and rebase alone can
      // outrun POST_TURN_HOLD_MAX_MS on a large repo.
      hold.take();
      reevaluateSessionAfterRewrite(runner);
      const pushOutcome = await tryForcePush(deps, baseBranch);
      const forcePushed = pushOutcome === "pushed";
      published = forcePushed;
      pushProhibited = pushOutcome === "refused";
      const headAfter = await git.getHeadHash();
      emitSyncCard(deps, { baseBranch, headFrom: headBefore, headTo: headAfter, baseMove, forcePushed });
      if (recordSync) {
        recordAgentNotice(deps, { baseBranch, headFrom: headBefore, headTo: headAfter, forcePushed, resolvedConflicts: false });
      }
      runner.emitMessage({ type: "rebase_complete", sessionId: runner.sessionId, forcePushed });
      return { status: "rebased", forcePushed };
    }

    let iter = 0;
    while (result.status === "conflicts") {
      iter++;
      // One window per attempt: notes append across rounds rather than replacing.
      if (followupAttempt.id === null) {
        followupAttempt.id = openFollowupWindow(runner.sessionId);
        deps.onFollowupWindowOpened?.(followupAttempt.id);
      }
      if (iter > MAX_REBASE_ITERATIONS) {
        try { await git.rebaseAbort(); } catch { /* may already be aborted */ }
        throw new ServiceError(
          500,
          `Too many conflict iterations (>${MAX_REBASE_ITERATIONS}) — rebase aborted`,
        );
      }

      runner.emitMessage({
        type: "rebase_conflicts",
        sessionId: runner.sessionId,
        conflicts: result.conflicts.map((c) => ({ path: c.path })),
      });

      // Reconcile git and worktree ownership before the worker edits conflict files.
      handWorkspaceBackToWorker(runner.sessionDir);

      const prompt = buildRebaseConflictPrompt(baseBranch, result.conflicts);
      try {
        await runRebaseResolutionTurn(deps, prompt, hold, systemHold);
      } catch (err) {
        // Abort before rethrowing; verify failures before reporting the branch unchanged.
        let stillInProgress = false;
        try {
          await git.rebaseAbort();
        } catch {
          try {
            stillInProgress = await git.isRebaseInProgress();
          } catch {
            stillInProgress = true;
          }
        }
        const outcomeText = stillInProgress
          ? MID_REBASE_TEXT
          : "The rebase was aborted — the branch is unchanged.";
        abortNoticeReached = true;
        const explained = persistAbortNotice(
          deps,
          `Rebase onto \`${baseBranch}\` was interrupted before the conflicts were resolved (${getErrorMessage(err)}). ${outcomeText}`,
        );
        throw explained ? markSyncFailureExplained(err) : err;
      }

      try {
        // Keep another commit from changing the index between staging and continuing.
        result = await withWorkspaceLock(runner.sessionDir, async () => {
          await git.stageAll();
          return git.rebaseContinue();
        });
      } catch (err) {
        try { await git.rebaseAbort(); } catch { /* may already be aborted */ }
        throw err;
      }
    }

    hold.take();
    reevaluateSessionAfterRewrite(runner);
    const resolvedPushOutcome = await tryForcePush(deps, baseBranch);
    const forcePushed = resolvedPushOutcome === "pushed";
    published = forcePushed;
    pushProhibited = resolvedPushOutcome === "refused";
    const headAfterResolve = await git.getHeadHash();
    emitSyncCard(deps, { baseBranch, headFrom: headBefore, headTo: headAfterResolve, baseMove, forcePushed });
    if (recordSync) {
      recordAgentNotice(deps, { baseBranch, headFrom: headBefore, headTo: headAfterResolve, forcePushed, resolvedConflicts: true });
    }
    runner.emitMessage({ type: "rebase_complete", sessionId: runner.sessionId, forcePushed });
    // Capture at the return point: the success paths return from inside the `try`.
    const notes = followupAttempt.id
      ? closeFollowupWindow(runner.sessionId, followupAttempt.id)
      : [];
    followupAttempt.id = null;
    return {
      status: "conflicts_resolved",
      iterations: iter,
      forcePushed,
      ...(notes.length > 0
        ? {
          followup: {
            notes,
            baseBranch,
            headFrom: headBefore,
            headTo: headAfterResolve,
            forcePushed,
          },
        }
        : {}),
    };
  } finally {
    // Released last, so a throw in this teardown cannot strand the lease. Re-taken
    // first: restoreLfsForSync's own begin/end would otherwise zero an expired depth
    // and then drop it, leaving the handback and the queue drain uncovered.
    try {
      hold.take();
      // Any other ending discards the arm: an unconcluded rebase leaves nothing to follow up.
      if (followupAttempt.id) closeFollowupWindow(runner.sessionId, followupAttempt.id);
      if (!abortNoticeReached) lastAbortNotice.delete(runner);
      // Aborts also restore LFS pointers; recover content before releasing queued turns.
      if (worktreeRewritten) await restoreLfsForSync(deps, baseBranch);
      // Consume successful or prohibited pushes; a fallback on base would bypass the PR.
      if (published) {
        pendingPush.arm = null;
      } else if (pushProhibited) {
        pendingPush.arm = null;
        if (savedCommit) {
          persistSyncNotice(
            deps,
            `Your uncommitted changes were saved as a local commit (${savedCommit.slice(0, 7)}), but it was `
            + `NOT pushed: this session is checked out on \`${baseBranch}\` itself, and pushing from a sync `
            + "would put the commit straight on that branch without a pull request. Push it deliberately "
            + "when you mean to.",
          );
        }
      } else {
        const arm = pendingPush.arm;
        pendingPush.arm = null;
        if (arm) {
          try {
            arm();
          } catch (err) {
            console.error("[rebase] arming the auto-push for the pre-sync commit failed:", getErrorMessage(err));
          }
        }
      }
      handWorkspaceBackToWorker(runner.sessionDir);
      // Clear on the hold's own ticket: a turn that displaced the driver, or another owner that
      // took over mid-flow, minted one of its own. Keying this on `runner.running` left a hold a
      // CLI-started turn was adopted under set with no owner at all (planning#554).
      if (runner.systemHoldSeq === systemHold.seq) runner.systemTurnInProgress = false;
      // The drain is NOT conditional on that: the queue can also be left by a hold that changed
      // hands, and `releaseQueuedTurn` declines on its own while a turn, a hold or a merge holds
      // the session — so it starts a turn only when nothing else can.
      try {
        releaseQueuedTurn(runner);
      } catch (releaseErr) {
        console.error("[rebase] post-flow queue release failed:", getErrorMessage(releaseErr));
      }
    } finally {
      hold.release();
    }
  }
}

/**
 * "refused" is distinct from "not-pushed" on purpose: the caller must consume
 * the pending auto-push rather than let it fall through. A plain fallback push
 * of a shared branch is the very thing the refusal exists to prevent, and it
 * would land the saved commit on that branch with no pull request.
 */
async function tryForcePush(
  deps: RebaseDriverDeps,
  baseBranch: string,
  /** Lease against the verified SHA so a later remote commit cannot be overwritten. */
  expectedRemoteSha?: string,
): Promise<UpToDatePushOutcome> {
  const { git, githubAuthManager, runner } = deps;
  if (!githubAuthManager.authenticated) return "not-pushed";
  try {
    const branch = await git.getCurrentBranch();
    // Refuse before checking anything else, exactly as `pushIfAheadOfRemote`
    // does. The base this sync targets is not the only shared branch: rebasing
    // against `stable` while checked out on `main` would still publish `main`.
    const shared = await findSharedBranchRefusal(git, branch, baseBranch);
    if (shared) {
      console.warn(`[rebase] refusing to force-push '${branch}': ${shared.role}, not a session branch`);
      return "refused";
    }
    const message = expectedRemoteSha === undefined
      ? await git.forcePush()
      : await git.forcePushWithLease("origin", branch, expectedRemoteSha);
    runner.emitMessage({ type: "github_push_result", success: true, message, branch });
    notifyPrStatusPollerOfPush(deps);
    return "pushed";
  } catch (err) {
    const errMsg = getErrorMessage(err);
    const failure = classifyPushFailure(err);
    console.error(`[rebase] force push failed [${failure}]:`, errMsg);
    if (isNonFastForwardError(err)) {
      runner.emitMessage({
        type: "git_push_rejected",
        reason: "non_fast_forward",
        message: "Force push rejected — remote moved since the last fetch. Try rebasing again.",
      });
    } else {
      const text = failure === "lfs"
        ? "Force push rejected: the remote refused it because its Git LFS objects were not uploaded (GH008). Run `git lfs push origin HEAD` in the terminal, then push again."
        : errMsg.includes("workflow")
          ? "Force push failed: your GitHub token needs the `workflow` scope to push GitHub Actions workflow files. Update your token at https://github.com/settings/tokens."
          : `Force push failed (${failure}): ${errMsg}`;
      runner.emitMessage({ type: "github_push_result", success: false, message: text });
      runner.emitMessage(agentLogAppend("server", text));
    }
    return "not-pushed";
  }
}

type UpToDatePushOutcome =
  | "pushed"
  | "not-pushed"
  | "refused";

async function pushIfAheadOfRemote(
  deps: RebaseDriverDeps,
  baseBranch: string,
): Promise<UpToDatePushOutcome> {
  const { git } = deps;
  try {
    const branch = await git.getCurrentBranch();
    // Refuse before checking auth: the caller must also suppress its fallback push.
    if (branch === baseBranch) return "refused";
    if (!deps.githubAuthManager.authenticated) return "not-pushed";
    const localHead = await git.getHeadHash();
    if (!localHead) return "not-pushed";
    // getCurrentBranch() reports a placeholder on detached HEAD ("HEAD", or its
    // own "main" fallback), which names a ref that is not what HEAD points at.
    // Verify the named ref really is the checked-out commit before pushing it.
    if ((await git.getRefHash(branch)) !== localHead) return "not-pushed";
    const remoteHead = await git.getRefHash(`origin/${branch}`);
    if (!remoteHead || remoteHead === localHead) return "not-pushed";
    if (!(await git.isAncestor(remoteHead, "HEAD"))) return "not-pushed";
    return await tryForcePush(deps, baseBranch, remoteHead);
  } catch (err) {
    console.error("[rebase] up-to-date push check failed:", getErrorMessage(err));
    return "not-pushed";
  }
}

// Refresh now and keep polling quickly while GitHub recomputes mergeability.
function notifyPrStatusPollerOfPush(deps: RebaseDriverDeps): void {
  const poller = deps.prStatusPoller;
  if (!poller) return;
  const sessionId = deps.runner.sessionId;
  try {
    poller.notifyAutoPush(sessionId);
    void poller.forceRefreshSession(sessionId).catch((err: unknown) => {
      console.error("[rebase] PR status refresh after push failed:", getErrorMessage(err));
    });
  } catch (err) {
    console.error("[rebase] notifying the PR poller after push failed:", getErrorMessage(err));
  }
}

async function runRebaseResolutionTurn(
  deps: RebaseDriverDeps,
  prompt: string,
  hold: RebaseRunnerHold,
  systemHold: SystemHoldTicket,
): Promise<void> {
  try {
    await dispatchRebaseResolutionTurn(deps, prompt, hold, systemHold);
  } finally {
    // The turn executor releases its own lease as this continuation is queued, so by
    // here it has let go — and if it had already expired, it took ours with it.
    hold.take();
  }
}

function dispatchRebaseResolutionTurn(
  deps: RebaseDriverDeps,
  prompt: string,
  hold: RebaseRunnerHold,
  systemHold: SystemHoldTicket,
): Promise<void> {
  const { runner } = deps;

  return new Promise<void>((resolve, reject) => {
    let turnSettled = false;

    deps.onAgentSpawned?.();

    // Unqueueable by construction: this flow holds systemTurnInProgress across the whole
    // rebase, so a queued entry could only drain after the hold this turn must release —
    // it would never settle, and the driver would own the session for ever (planning#297).
    runner.dispatch(prepareDispatch({
      text: prompt,
      agentInterface: undefined,
      activity: "Resolving conflicts...",
      // Rebase owns the commits, push, and queue drain.
      postTurn: "none",
      systemTurn: true,
      execution: undefined,
      images: undefined,
      files: undefined,
      uploads: undefined,
      permissionMode: undefined,
      deliveryId: undefined,
      dictated: undefined,
      resetMergedBranch: undefined,
      compactContext: undefined,
      silent: undefined,
      onTurnComplete: (outcome) => {
        // Late duplicate callbacks must not re-lock the runner after the flow releases it.
        if (turnSettled) return;
        turnSettled = true;
        // Restore the flow's holds synchronously after finishTurn clears the per-turn
        // flag; an unexpired turn lease is still held here, so nothing reads idle between.
        if (!runner.running) takeSystemHold(runner, systemHold);
        hold.take();
        if (outcome.status === "completed") {
          resolve();
          return;
        }
        if (outcome.status === "refused") {
          // Transient in every case: 409 defers the automatic retry without spending an attempt.
          reject(new ServiceError(
            409,
            `Cannot resolve conflicts right now — ${outcome.detail ?? "the turn could not be started"}`,
          ));
          return;
        }
        reject(new Error(
          outcome.status === "errored"
            ? "Agent error during rebase conflict resolution"
            : `the conflict-resolution turn ended as "${outcome.status}"${outcome.detail ? ` — ${outcome.detail}` : ""}`,
        ));
      },
    }), { whenBusy: "refuse" });

    // dispatch claims the turn synchronously, so `running` now says whether it started.
    // A refusal settled inside the call above, and its hold must survive to the flow.
    if (runner.running && !turnSettled) hold.release();
  });
}

export const AUTO_RESOLVE_ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000;

// A deferred failure retries every minute, so log each distinct raw error once per runner.
const lastLoggedAutoResolveFailure = new WeakMap<SessionRunnerInterface, string>();

/** `lastError` reaches the PR card, so it carries git's summary; the console keeps the raw text. */
function autoResolveFailureText(runner: SessionRunnerInterface, stage: string, err: unknown): string {
  const summary = summarizeGitError(getErrorMessage(err));
  const key = `${stage}:${summary}`;
  if (lastLoggedAutoResolveFailure.get(runner) !== key) {
    lastLoggedAutoResolveFailure.set(runner, key);
    console.error(`[auto-resolve] ${stage} failed for session ${runner.sessionId}:`, err);
  }
  return summary;
}

export async function runAutoResolveAttempt(
  deps: RebaseDriverDeps & {
    timeoutMs?: number;
    now?: () => number;
  },
  baseBranch: string,
): Promise<AutoResolveResult> {
  const { git, githubAuthManager, runner } = deps;

  if (!githubAuthManager.authenticated) {
    return { outcome: "deferred", lastError: "no_github_auth", didWork: false };
  }

  // The resolution turn would be refused anyway; without this the flow fetches, rebases
  // and aborts under a running agent once per retry (nikzlabs/shipit#2751).
  if (residentBackgroundWork(runner).length > 0) {
    return { outcome: "deferred", lastError: AUTO_RESOLVE_DEFER_BACKGROUND_WORK, didWork: false };
  }

  try {
    const clean = await git.isClean();
    if (!clean) {
      return { outcome: "deferred", lastError: "dirty_tree", didWork: false };
    }
  } catch (err) {
    return {
      outcome: "deferred",
      lastError: `is_clean_failed: ${autoResolveFailureText(runner, "is_clean", err)}`,
      didWork: false,
    };
  }

  try {
    if (await git.isRebaseInProgress()) {
      try { await git.rebaseAbort(); } catch { /* may already be aborted */ }
      handWorkspaceBackToWorker(runner.sessionDir);
      return { outcome: "deferred", lastError: "stale_rebase", didWork: false };
    }
  } catch (err) {
    return {
      outcome: "deferred",
      lastError: `is_rebase_in_progress_failed: ${autoResolveFailureText(runner, "is_rebase_in_progress", err)}`,
      didWork: false,
    };
  }

  let didSpawn = false;
  let settled = false;
  let timedOut = false;
  const followupAttempt: { id: string | null } = { id: null };
  const wrappedDeps: RebaseDriverDeps = {
    ...deps,
    onAgentSpawned: () => { didSpawn = true; },
    onFollowupWindowOpened: (attemptId) => {
      // The deadline may already have fired: the flow is raced, not cancelled, so it can reach
      // its first conflict afterwards, with no deadline left to close what it opens.
      if (timedOut) {
        closeFollowupWindow(runner.sessionId, attemptId);
        return;
      }
      followupAttempt.id = attemptId;
    },
  };

  const timeoutMs = deps.timeoutMs ?? AUTO_RESOLVE_ATTEMPT_TIMEOUT_MS;

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<AutoResolveResult>((resolve) => {
    timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      timedOut = true;
      // A hanging agent leaves the resolution turn's promise pending for ever, so the flow's
      // `finally` never runs. Without this the arm would wake on a later, unrelated rebase.
      if (followupAttempt.id) closeFollowupWindow(runner.sessionId, followupAttempt.id);
      void (async () => {
        // The flow dropped its lease when the turn started, so `running` was the only
        // cover; clearing it below hands the runner to the idle enforcer, which
        // onAgentFinished() invokes synchronously through the runner's `idle` event.
        runner.beginPostTurnWork();
        try {
          try { runner.getAgent()?.kill(); } catch { /* defensive */ }
          runner.setAgent(null);
          runner.running = false;
          runner.systemTurnInProgress = false;
          runner.onAgentFinished();
          try { await git.rebaseAbort(); } catch { /* may already be aborted */ }
          runner.emitMessage({ type: "rebase_aborted", sessionId: runner.sessionId });
        } finally {
          runner.endPostTurnWork();
        }
        resolve({ outcome: "error", lastError: "timeout", didWork: true });
      })();
    }, timeoutMs);
  });

  const concluded: { outcome: RebaseFlowOutcome | null } = { outcome: null };
  const flowPromise = (async (): Promise<AutoResolveResult> => {
    try {
      const result = await runRebaseFlow(wrappedDeps, baseBranch);
      concluded.outcome = result;
      if (result.status === "up_to_date" && !result.forcePushed) {
        // rebase_complete already cleared the banner; avoid a contradictory deferred event.
        return { outcome: "deferred", didWork: false, suppressEmit: true };
      }
      // A push needs the settle window even when no rebase was needed.
      return { outcome: "success", forcePushed: result.status !== "aborted" && "forcePushed" in result ? result.forcePushed : false, didWork: true };
    } catch (err) {
      if (err instanceof ServiceError && err.statusCode === 409) {
        // Background work started inside the pre-flight window: the same persistent
        // refusal, so it takes the same long cooldown rather than the transient one.
        return residentBackgroundWork(runner).length > 0
          ? { outcome: "deferred", lastError: AUTO_RESOLVE_DEFER_BACKGROUND_WORK, didWork: false }
          : { outcome: "deferred", didWork: false };
      }
      if (!didSpawn) {
        return { outcome: "deferred", lastError: autoResolveFailureText(runner, "rebase flow", err), didWork: false };
      }
      try { await git.rebaseAbort(); } catch { /* may already be aborted */ }
      return { outcome: "error", lastError: autoResolveFailureText(runner, "rebase flow", err), didWork: true };
    }
  })();

  // Once the deadline fires, the attempt IS a timeout. The abort it performs runs
  // against a tree the flow may still be rebasing, so the interrupted flow reports
  // the wreckage ("your local changes would be overwritten by merge") and, being
  // pre-spawn, reports it as `deferred` — which costs no attempt and retries into
  // the same timeout every minute. Whoever wins the race, the timeout's verdict is
  // the true one; awaiting it also waits for its abort to finish.
  let winner = await Promise.race([flowPromise, timeoutPromise]);
  if (timedOut) winner = await timeoutPromise;
  settled = true;
  if (timeoutHandle) clearTimeout(timeoutHandle);
  handWorkspaceBackToWorker(runner.sessionDir);
  // Timeout aborts can outlast the flow's restoration. Restore again before draining.
  await restoreLfsForSync(deps, baseBranch);
  try {
    await deps.drainQueue?.();
  } catch (err) {
    console.error("[auto-resolve] drainQueue failed:", err);
  }
  // After this path's own cleanup, not merely after the flow's: LFS restoration rewrites files
  // in place, and a follow-up turn started before it would edit a tree still being rewritten.
  const outcome = concluded.outcome;
  if (!timedOut && outcome?.status === "conflicts_resolved" && outcome.followup) {
    deliverRebaseFollowup(deps, outcome.followup);
  }
  return winner;
}
