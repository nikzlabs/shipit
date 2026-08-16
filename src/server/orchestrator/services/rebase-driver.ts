/**
 * Rebase driver — orchestrates the full rebase flow with agent-driven conflict
 * resolution.
 *
 * Lifecycle:
 *   1. Fetch latest from origin.
 *   2. Check ancestry — if HEAD is up-to-date, emit complete and return.
 *   3. Attempt git rebase onto base ref.
 *   4. On conflicts: emit `rebase_started` + `rebase_conflicts`, send the agent
 *      a system message with conflict context, await agent completion, then
 *      stage all files and run `git rebase --continue`. Repeat until clean
 *      (multi-commit rebases may surface conflicts at multiple steps).
 *   5. Once the rebase completes cleanly, force-push (best-effort — no auth
 *      means we still report `rebase_complete` with `forcePushed: false`).
 *
 * The driver bypasses the standard system-turn flow because system turns
 * auto-commit + auto-push, both of which would corrupt a rebase. Instead it
 * spawns an agent directly, persists chat messages manually, and handles its
 * own lifecycle.
 */

import { randomUUID } from "node:crypto";
import type { GitManager, RebaseConflictFile } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { AgentProcess, AgentId, BranchSyncedCard } from "../../shared/types.js";
import type { ChatHistoryManager } from "../chat-history.js";
import type { SessionManager } from "../sessions.js";
import type { UsageManager } from "../usage.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import { ServiceError } from "./types.js";
import { agentLogAppend } from "../log-emit.js";
import { emitNoticePostTurn } from "../chat-card-persistence.js";
import { releaseQueuedTurn } from "../queue-drain.js";
import { isNonFastForwardError } from "./git.js";
import { getErrorMessage } from "../validation.js";
import { handWorkspaceBackToWorker } from "../session-worker-uid.js";
import { restoreLfsAfterTreeRewrite } from "../git-lfs.js";
import type { AutoResolveResult } from "../auto-conflict-resolve-manager.js";
import { prepareDispatch } from "../prepared-dispatch.js";

// Hand the whole session workspace (worktree + `.git`) back to the worker uid
// after the rebase driver's root git ops (planning#146). A rebase rewrites BOTH as
// root:root, and because the driver dispatches turns with `postTurn: "none"`
// the normal post-turn handoff never runs — so without the worktree handback the
// non-root agent can run git but can't EDIT the conflicted files it must
// resolve. Shared with the session-setup + fork-merge paths via
// `handWorkspaceBackToWorker` (session-worker-uid.ts); no-op when the flag is
// unset.

/**
 * Maximum number of conflict iterations before bailing out. A multi-commit
 * rebase may surface conflicts more than once, but we cap iterations so a
 * misbehaving agent (or pathological repo state) cannot loop forever.
 */
export const MAX_REBASE_ITERATIONS = 10;

export interface RebaseDriverDeps {
  git: GitManager;
  githubAuthManager: GitHubAuthManager;
  runner: SessionRunnerInterface;
  sessionManager: SessionManager;
  chatHistoryManager: ChatHistoryManager;
  /**
   * Usage + auth managers needed by the shared agent listener
   * (`wireAgentListeners`). Without these the conflict-resolution turn would
   * skip per-turn cost/token tracking and couldn't kick off OAuth on
   * `auth_required`. Shared with the WS path so the rebase turn is just
   * "a user turn with the post-turn commit/push elided" — see
   * `runRebaseResolutionTurn`.
   */
  usageManager: UsageManager;
  /** Factory for creating agents. Falls back to runner.createAgent if available. */
  agentFactory?: (agentId: AgentId) => AgentProcess;
  sseBroadcast: (event: string, data: unknown) => void;
  /**
   * docs/146 — fired immediately after `runner.setAgent(agent)` in
   * `runRebaseResolutionTurn`, so the auto-resolve wrapper can mark the
   * "agent was spawned" boundary. Anything thrown BEFORE this fires is a
   * pre-spawn failure (fetch, ancestry check) and should not burn a budget
   * attempt; anything thrown AFTER means real work happened. Optional —
   * user-driven rebases ignore this.
   */
  onAgentSpawned?: () => void;
  /**
   * docs/146 — drain callback fired after an auto-resolve attempt fully
   * settles, so a user message queued during the attempt drains only after
   * the rebase is continued/aborted and the repo is out of the conflict
   * state. Optional — tests / user-driven rebases can leave it unset.
   */
  drainQueue?: () => Promise<void> | void;
  /**
   * docs/221 — emit the persisted "Synced with <base>" transcript card when the
   * sync actually changed something (branch rebased and/or local `<base>` moved),
   * and — when the branch itself moved — record the matching agent-facing notice
   * for the next turn (`buildBranchSyncAgentNotice`). One flag covers both because
   * they are the same question asked of two audiences: "did a human ask for this
   * sync out of band, so does someone need telling?"
   * Set true ONLY by the manual "Sync with <base>" route — the automatic
   * conflict-resolve-on-idle path leaves it unset so it keeps its own
   * `auto_resolve_result` envelopes and doesn't gain a surprise card. The local
   * `<base>` fast-forward itself is unconditional (it's plain correctness).
   */
  recordSyncCard?: boolean;
  /**
   * The PR-status poller, so a push made by this flow can tell the poller about
   * itself. Structurally typed (not `PrStatusPoller`) to keep the driver free of
   * that import and let tests pass a two-method stub; optional because several
   * test setups construct the driver without a poller at all.
   *
   * Why the driver and not the call sites (planning#369): a rebase + force-push is what CLEARS
   * GitHub's `CONFLICTING` state, and until the poller observes that, the PR card
   * keeps its "Merge conflicts" chip and "Resolve conflicts" button. Nothing else
   * tells it. `POST /git/rebase` never called `forceRefreshSession`, and
   * `tryForcePush` never called `notifyAutoPush` (only the auto-push scheduler
   * did), so the session stayed in the 120s slow bucket and the chip survived the
   * fix that removed the conflict — up to two minutes, and indefinitely while the
   * polling gate is closed. Putting both calls next to the push itself means every
   * caller (the user-driven route AND the auto-conflict-resolve path) inherits
   * them, and a future caller cannot forget.
   */
  prStatusPoller?: RebasePrStatusPoller | null;
}

/**
 * The slice of `PrStatusPoller` the rebase driver uses after a push.
 * `notifyAutoPush` moves the session into the fast (15s) cadence bucket;
 * `forceRefreshSession` is the immediate one-shot that bypasses the global gate.
 */
export interface RebasePrStatusPoller {
  notifyAutoPush(sessionId: string): void;
  forceRefreshSession(sessionId: string): Promise<void>;
}

export type RebaseFlowOutcome =
  /**
   * HEAD already contained `<base>`, so nothing was replayed — but the branch
   * may still have been pushed, when it held commits origin had never seen.
   * `forcePushed` is what the auto-resolve wrapper needs to tell a genuine
   * no-op apart from a push that just changed the head SHA on GitHub.
   */
  | { status: "up_to_date"; forcePushed: boolean }
  | { status: "rebased"; forcePushed: boolean }
  | { status: "conflicts_resolved"; iterations: number; forcePushed: boolean }
  | { status: "aborted"; reason: string };

/** Build the conflict resolution prompt sent to the agent. */
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
  ].join("\n");
}

/** docs/221 — the local-`<base>`-ref move outcome (`from`/`to` shas). */
interface LocalBaseMove {
  /** Local `<base>` sha before the move; null if the local ref didn't exist. */
  from: string | null;
  /** `origin/<base>` sha the local ref now points at. */
  to: string;
}

/**
 * docs/221 — fast-forward the session clone's local `<base>` ref up to
 * `origin/<base>` after a fetch, WITHOUT checking it out. A session clone's
 * default refspec only advances `origin/<base>`; local `<base>` stays frozen at
 * clone time (docs/157), so the agent's `git diff main...HEAD` etc. reference
 * stale code after a sync. Best-effort: any failure logs and returns null
 * (a ref-move must never abort the rebase). Returns null when `origin/<base>`
 * doesn't resolve. Skips the actual move (but still reports the shas) when the
 * session is somehow ON the base branch, since `git branch -f` refuses that.
 */
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

/**
 * docs/221 — emit the persisted branch-updated card whenever a manual sync
 * completes, including when everything was already current. The clean-rebase
 * path is not an agent turn, so the card is appended
 * directly to chat history AND broadcast over WS, sharing one `cardId` the
 * client dedupes on (mirrors `emitNoticePostTurn`). Returns true when a card was
 * emitted — the caller uses that to suppress the redundant "Already up to date"
 * toast on the up-to-date path.
 */
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
  chatHistoryManager.append(runner.sessionId, { role: "assistant", text: "", branchSynced: card });
  runner.emitMessage({ type: "branch_synced_card", sessionId: runner.sessionId, card });
  return true;
}

/**
 * docs/221 — record the agent-facing notice for a manual sync that actually
 * moved the branch. Best-effort: the sync itself succeeded and is already
 * recorded for the user, so a failed DB write must not turn a completed rebase
 * into a reported failure.
 */
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

/**
 * docs/221 — the agent-facing counterpart of the "Synced with `<base>`" card.
 *
 * The card tells the USER what happened; nothing told the AGENT. A manual sync
 * runs outside any turn (`runRebaseFlow` refuses while one is running), so
 * there is no prompt to prepend to at the time — but the agent is resumed with
 * a conversation that predates the rewrite, and every file it read earlier may
 * now differ. Recorded as a pending notice and drained by the next interactive
 * turn (`agent-execution.ts`), mirroring the docs/218 post-merge reset prefix.
 *
 * Only emitted when the branch actually moved. A sync that merely fast-forwards
 * the local `<base>` ref leaves the agent's working tree byte-identical, so it
 * has nothing to warn about.
 */
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

/**
 * A rebase rewrites the whole working tree from the ORCHESTRATOR, outside the
 * session container — so the newly-checked-out `shipit.yaml` / compose file can
 * declare services, an install step, or a compose path the running session
 * knows nothing about.
 *
 * The session's compose stack is otherwise re-evaluated only when the
 * in-container inotify watcher reports a config file changed, which is the
 * wrong signal for this: it is started best-effort (a single fire-and-forget
 * POST per runner) and watches a bind mount the orchestrator wrote to from
 * another container. When it misses the write — or was never started — the
 * user rebases onto the latest base and the new service simply never appears.
 *
 * The orchestrator knows exactly when it rewrote the tree, so it says so
 * directly. Best-effort: a config re-read must never fail a completed rebase.
 */
function reevaluateSessionConfig(runner: SessionRunnerInterface): void {
  try {
    runner.reevaluateWorkspaceConfig?.();
  } catch (err) {
    console.error("[rebase] config re-evaluation failed:", getErrorMessage(err));
  }
}

/**
 * Run the full rebase flow. Emits WS events through the runner so the client
 * can update its UI as the flow progresses.
 *
 * Throws ServiceError on validation problems (e.g. agent already running,
 * unresolvable base branch). Internal failures (force push errors, etc.) are
 * reported via WS events rather than thrown.
 */
export async function runRebaseFlow(
  deps: RebaseDriverDeps,
  baseBranch: string,
): Promise<RebaseFlowOutcome> {
  const { git, runner } = deps;
  const recordSync = deps.recordSyncCard ?? false;
  // nikzlabs/shipit#2349 — flipped the moment the flow can have re-materialized
  // worktree files, so the `finally` knows whether it owes an LFS restore. Set
  // before `git.rebase`, which is the first op here that writes the worktree:
  // the fetch and the local-base-ref move touch only `.git`, and the up-to-date
  // short-circuit returns without rewriting anything.
  let worktreeRewritten = false;

  if (runner.running) {
    throw new ServiceError(409, "Cannot rebase while an agent turn is in progress");
  }
  // planning#338 — the hold below is exclusive. A second flow entering while the
  // first holds the session between its own turns (`running` false, flag true)
  // would run two rebases against one working tree and clear the shared flag on
  // its own teardown. The auto path translates this 409 into a deferral.
  if (runner.systemTurnInProgress) {
    throw new ServiceError(409, "Cannot rebase while a system turn is in progress");
  }

  // planning#338 — hold the system-turn marker for the WHOLE flow, not just while a
  // resolution turn is in flight. The per-turn flag has two gaps a user turn
  // slipped through in production: (a) the executor's `tryDrain` clears
  // `running` at `agent_result`, seconds before `done` settles the turn, and
  // (b) between resolution turns (and around the final continue/force-push) the
  // driver runs git against the workspace with no turn in flight at all. A user
  // message dispatched in either gap displaces the resolution turn's agent slot
  // and strands the workspace mid-rebase — auto-commit then refuses forever
  // ("rebase in progress") until a human aborts by hand. Every user-turn entry
  // path (WS send, `dispatchOnRunner`, `releaseQueuedTurn`) now respects this
  // flag, so messages queue and drain after the flow settles (docs/146's
  // original intent). The executor still clears the flag at each resolution
  // turn's teardown; `runRebaseResolutionTurn.onTurnComplete` re-asserts it
  // synchronously, so there is no observable gap.
  runner.systemTurnInProgress = true;

  try {
    // 1. Fetch latest from origin.
    await git.fetch("origin");

    // 2. Resolve the base branch ref.
    const baseRef = await git.resolveBaseBranchRef(baseBranch);
    if (!baseRef) {
      throw new ServiceError(400, `Cannot resolve base branch: ${baseBranch}`);
    }

    // docs/221 — fast-forward the local `<base>` ref to origin/<base> (the fetch
    // above only advanced the remote-tracking ref) and snapshot the session
    // branch HEAD, so a successful sync can record both moves on the card.
    const headBefore = await git.getHeadHash();
    const baseMove = await syncLocalBaseRef(git, baseBranch);

    // 3. Check ancestry — already up-to-date?
    const isAncestor = await git.isAncestor(baseRef, "HEAD");
    if (isAncestor) {
      // ...locally. GitHub computes `mergeable` from the PUSHED head, so a
      // branch that already contains `<base>` but never reached origin (an
      // auto-push rejected as non-fast-forward, a push that failed while the
      // container was going away) is still CONFLICTING as far as the PR card is
      // concerned — and this path used to return without pushing anything, so
      // every further click on "Resolve conflicts" repeated the same no-op.
      // Publish the commits the remote is missing; that is the whole fix.
      const forcePushed = await pushIfAheadOfRemote(deps, baseBranch);
      // Manual syncs always leave a durable confirmation card, including the
      // already-current case. Automatic conflict resolution remains cardless.
      const cardEmitted = recordSync
        ? emitSyncCard(deps, { baseBranch, headFrom: headBefore, headTo: headBefore, baseMove, forcePushed })
        : false;
      runner.emitMessage({ type: "rebase_complete", sessionId: runner.sessionId, forcePushed, upToDate: true, baseMoved: cardEmitted });
      return { status: "up_to_date", forcePushed };
    }

    // 4. Begin rebase.
    runner.emitMessage({ type: "rebase_started", sessionId: runner.sessionId, baseBranch });

    // Errors propagate to the route's `flowPromise.catch`, which emits a single
    // `rebase_aborted` carrying the error message. Don't emit here too — before
    // this dedupe the user got two aborts for one failure.
    worktreeRewritten = true;
    let result = await git.rebase(baseRef);

    // 5. Clean rebase — go straight to force push.
    if (result.status === "clean") {
      reevaluateSessionConfig(runner);
      const forcePushed = await tryForcePush(deps);
      if (recordSync) {
        const headAfter = await git.getHeadHash();
        emitSyncCard(deps, { baseBranch, headFrom: headBefore, headTo: headAfter, baseMove, forcePushed });
        recordAgentNotice(deps, { baseBranch, headFrom: headBefore, headTo: headAfter, forcePushed, resolvedConflicts: false });
      }
      runner.emitMessage({ type: "rebase_complete", sessionId: runner.sessionId, forcePushed });
      return { status: "rebased", forcePushed };
    }

    // 6. Conflict loop — delegate resolution to the agent.
    let iter = 0;
    while (result.status === "conflicts") {
      iter++;
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

      // planning#146: `git.rebase` above ran as the root orchestrator and re-rooted
      // BOTH `.git` AND the worktree — including the conflicted files this turn's
      // agent must EDIT. Hand the whole workspace back to the worker uid BEFORE
      // the resolution turn so the non-root agent can both run git and write the
      // conflicted files (the root orchestrator can still operate the
      // worker-owned tree via the `safe.directory=*` global config). No-op when
      // the flag is unset.
      handWorkspaceBackToWorker(runner.sessionDir);

      const prompt = buildRebaseConflictPrompt(baseBranch, result.conflicts);
      try {
        await runRebaseResolutionTurn(deps, prompt);
      } catch (err) {
        // planning#338 — the resolution turn ended without completing: an agent
        // process error, a no-result exit, a runner disposal, or a newer turn
        // displacing its agent slot. Abort HERE, before rethrowing, so the
        // workspace can never strand mid-rebase with auto-commit refusing every
        // later turn. (The auto-resolve wrapper aborts on its own catch too —
        // idempotent — but the user-driven route only emits `rebase_aborted`
        // and never touched git, which is exactly how the production incident
        // stuck.) The notice is persisted, not just emitted: it is the whole
        // durable record of why the sync the user asked for did not happen.
        // A failed abort must not masquerade as a clean one: the notice below
        // is the durable record, and telling the user "the branch is
        // unchanged" while the workspace is still mid-rebase re-creates the
        // silent-stranding this path exists to prevent. Verify.
        let stillInProgress = false;
        try {
          await git.rebaseAbort();
        } catch {
          try {
            stillInProgress = await git.isRebaseInProgress();
          } catch {
            stillInProgress = true; // can't verify — assume the worst, say so
          }
        }
        const outcomeText = stillInProgress
          ? "Aborting the rebase FAILED — the workspace is still mid-rebase; run `git rebase --abort` to recover."
          : "The rebase was aborted — the branch is unchanged.";
        try {
          emitNoticePostTurn(
            (m) => runner.emitMessage(m),
            deps.chatHistoryManager,
            runner.sessionId,
            `Rebase onto \`${baseBranch}\` was interrupted before the conflicts were resolved (${getErrorMessage(err)}). ${outcomeText}`,
            "warn",
          );
        } catch (noticeErr) {
          console.error("[rebase] abort notice failed:", getErrorMessage(noticeErr));
        }
        throw err;
      }

      // The agent may have left files unmodified or staged. `add -A` covers both.
      await git.stageAll();

      try {
        result = await git.rebaseContinue();
      } catch (err) {
        // Continue can fail if there is nothing staged (agent didn't actually
        // resolve anything). Abort to leave the tree clean. The route's
        // `flowPromise.catch` emits a single `rebase_aborted` with the reason.
        try { await git.rebaseAbort(); } catch { /* may already be aborted */ }
        throw err;
      }
    }

    // 7. Force push after successful resolution.
    reevaluateSessionConfig(runner);
    const forcePushed = await tryForcePush(deps);
    if (recordSync) {
      const headAfter = await git.getHeadHash();
      emitSyncCard(deps, { baseBranch, headFrom: headBefore, headTo: headAfter, baseMove, forcePushed });
      // The conflict-resolution turns told the agent about the *conflicts*, not
      // about the branch move that follows them — and those turns end before the
      // continue/force-push. It still needs the same "your tree was rewritten"
      // notice on its next turn.
      recordAgentNotice(deps, { baseBranch, headFrom: headBefore, headTo: headAfter, forcePushed, resolvedConflicts: true });
    }
    runner.emitMessage({ type: "rebase_complete", sessionId: runner.sessionId, forcePushed });
    return { status: "conflicts_resolved", iterations: iter, forcePushed };
  } finally {
    // nikzlabs/shipit#2349 — the rebase re-materialized worktree files through the
    // ORCHESTRATOR's git, whose LFS smudge filter is disabled by design, so every
    // LFS-tracked path it touched is now ~130 bytes of pointer text while the
    // tree reads CLEAN. Restore the content before anyone looks at it.
    //
    // In the `finally` rather than on the two success paths because an ABORT
    // rewrites the worktree too — it checks the pre-rebase tree back out through
    // the same filter-less git, so a failed sync leaves stubs where a successful
    // one would have. By the time this runs the tree is settled (every path that
    // leaves the loop mid-rebase aborts first), which is the precondition
    // `restoreLfsAfterTreeRewrite` documents.
    //
    // Ahead of the queue release, not after it: a turn queued during the sync
    // would otherwise start against the stubs, which is the exact failure this
    // closes. Non-LFS repos pay one `git grep` for that ordering.
    if (worktreeRewritten) {
      await restoreLfsAfterTreeRewrite(runner.sessionDir, `Sync with ${baseBranch}`, (message) =>
        deps.sseBroadcast("error", { message }),
      );
    }
    // planning#146 / docs/150 §7: every orchestrator git op above (fetch, rebase,
    // rebaseContinue, stageAll, forcePush, rebaseAbort) runs as root and leaves
    // BOTH `.git` and the rewritten worktree files root-owned. Unlike a normal
    // turn, the rebase driver dispatches its resolution turns with
    // `postTurn: "none"`, which elides the post-turn handoff — so without this
    // the non-root agent's next in-container `git` fails on a root-owned `.git`
    // AND a later turn can't edit any rebase-rewritten file. Hand the whole
    // workspace back on every exit path (clean, resolved, up-to-date, abort,
    // throw). No-op when the flag is unset.
    handWorkspaceBackToWorker(runner.sessionDir);
    // planning#338 — release the flow's hold, then start the head of the queue.
    // Skipped while a DISPLACING turn still owns the runner (`running` — it is
    // never a system turn, so the flag is not its): clearing under it would
    // re-enable steering into it mid-turn, and its own post-turn drain owns the
    // queue. The release covers the user-driven path, which — unlike the
    // auto-resolve path with its `drainQueue` callback — previously had no
    // post-flow drain at all, so a message queued during the flow just sat
    // there. `releaseQueuedTurn` no-ops on an empty queue.
    if (!runner.running) {
      runner.systemTurnInProgress = false;
      // Defensive: a disposed runner refuses dispatch; a failed release must
      // not turn a settled flow into an unhandled rejection.
      try {
        releaseQueuedTurn(runner);
      } catch (releaseErr) {
        console.error("[rebase] post-flow queue release failed:", getErrorMessage(releaseErr));
      }
    }
  }
}

/**
 * Attempt a force push with lease. Returns true on success, false if push
 * was skipped (no auth) or failed.
 *
 * Emits the same WS events as the regular auto-push flow so the user sees
 * confirmation on success and an actionable error on failure — without these,
 * the rebase appears "complete" while the rewritten history never reaches
 * origin (see also `scheduleAutoPush` in index.ts / app-lifecycle.ts).
 *
 * On success it also notifies the PR-status poller — see `prStatusPoller` in
 * `RebaseDriverDeps` for why that call lives here rather than at the call sites.
 */
async function tryForcePush(
  deps: RebaseDriverDeps,
  /**
   * Lease against THIS sha instead of the remote's live tip.
   *
   * `git.forcePush()` re-reads the live tip and leases against whatever it finds,
   * which is right after a rebase (ShipIt owns the branch, and the only
   * legitimate remote state is the pre-rebase commits it pushed itself) but wrong
   * for a caller that decided to push *because* it verified a specific remote
   * sha: a commit landing between that check and the push would become the lease
   * and be overwritten. Pass the checked sha and the push is rejected instead.
   */
  expectedRemoteSha?: string,
): Promise<boolean> {
  const { git, githubAuthManager, runner } = deps;
  if (!githubAuthManager.authenticated) return false;
  try {
    const branch = await git.getCurrentBranch();
    const message = expectedRemoteSha === undefined
      ? await git.forcePush()
      : await git.forcePushWithLease("origin", branch, expectedRemoteSha);
    runner.emitMessage({ type: "github_push_result", success: true, message, branch });
    notifyPrStatusPollerOfPush(deps);
    return true;
  } catch (err) {
    const errMsg = getErrorMessage(err);
    console.error("[rebase] force push failed:", errMsg);
    if (isNonFastForwardError(err)) {
      runner.emitMessage({
        type: "git_push_rejected",
        reason: "non_fast_forward",
        message: "Force push rejected — remote moved since the last fetch. Try rebasing again.",
      });
    } else {
      const text = errMsg.includes("workflow")
        ? "Force push failed: your GitHub token needs the `workflow` scope to push GitHub Actions workflow files. Update your token at https://github.com/settings/tokens."
        : `Force push failed: ${errMsg}`;
      runner.emitMessage({ type: "github_push_result", success: false, message: text });
      runner.emitMessage(agentLogAppend("server", text));
    }
    return false;
  }
}

/**
 * Push on the up-to-date path when the local branch is strictly AHEAD of
 * `origin/<branch>` — i.e. it holds commits the remote has never seen.
 *
 * The up-to-date short-circuit answers a purely LOCAL question ("does HEAD
 * already contain `<base>`?"), while the PR card's conflict state is computed by
 * GitHub from the PUSHED head. Those disagree exactly when a commit never made
 * it to origin, and the user experiences it as a "Resolve conflicts" button that
 * does nothing, forever, however many times they press it.
 *
 * Deliberately narrow — four things must all hold, and each excludes a way this
 * could publish something nobody asked it to:
 *
 *  1. **The session is not on the base branch.** `syncLocalBaseRef` already
 *     handles a session sitting on `<base>`, so it happens. `origin/main` is
 *     trivially an ancestor of a `main` checkout carrying local commits, and
 *     without this clause "Sync with main" would push straight to `main`,
 *     bypassing the pull request entirely.
 *  2. **The branch ref resolves to HEAD.** On a detached HEAD
 *     `getCurrentBranch()` falls back to the literal `"main"`, so the ancestry
 *     question would be asked of one ref and the push aimed at another — landing
 *     commits on a branch the caller never named and reporting success.
 *  3. **`origin/<branch>` exists.** Publishing a branch for the first time
 *     belongs to the auto-push path, not to "sync with base".
 *  4. **The remote tip is an ANCESTOR of HEAD** — the fast-forward case, and the
 *     one this bug produces. A genuinely diverged remote is left alone; resolving
 *     that is the rebase path's job, not a silent history rewrite from the no-op
 *     branch. The verified sha is then handed to the push as its lease, so a
 *     commit that lands in between is rejected rather than clobbered.
 *
 * Returns true only when a push actually landed. Any inspection failure returns
 * false: an unpushed commit is a recoverable state, and a git error here must not
 * fail a sync that is otherwise a no-op.
 */
async function pushIfAheadOfRemote(deps: RebaseDriverDeps, baseBranch: string): Promise<boolean> {
  const { git } = deps;
  try {
    if (!deps.githubAuthManager.authenticated) return false;
    const branch = await git.getCurrentBranch();
    if (branch === baseBranch) return false;
    const localHead = await git.getHeadHash();
    if (!localHead) return false;
    if ((await git.getRefHash(branch)) !== localHead) return false;
    const remoteHead = await git.getRefHash(`origin/${branch}`);
    if (!remoteHead || remoteHead === localHead) return false;
    if (!(await git.isAncestor(remoteHead, "HEAD"))) return false;
    return await tryForcePush(deps, remoteHead);
  } catch (err) {
    console.error("[rebase] up-to-date push check failed:", getErrorMessage(err));
    return false;
  }
}

/**
 * Tell the PR-status poller that this session's branch just reached origin:
 * move it into the fast cadence bucket, then poll once immediately.
 *
 * Both halves are needed. `forceRefreshSession` alone gives one fresh reading,
 * but GitHub recomputes `mergeable` asynchronously and often answers `UNKNOWN`
 * on the first ask; `notifyAutoPush` alone leaves the session waiting up to a
 * full slow tick (120s) for that first reading. Together the card converges in
 * seconds.
 *
 * Best-effort and non-blocking: the push already succeeded, so neither a missing
 * poller nor a failed refresh may turn a completed rebase into a reported failure.
 */
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

/**
 * Run an agent turn dedicated to resolving rebase conflicts.
 *
 * docs/169 — the turn lifecycle now lives entirely on the shared dispatch path
 * (`runner.dispatch` → `runDispatchedTurn` → `executeAgentTurn`). That path
 * already owns: a fresh agent, the `running` / `systemTurnInProgress` flag
 * management, the synchronous `_isRunning=true` race fix, the shared
 * `wireAgentListeners` (so chat history accumulates the same message-group
 * structure as a WS user turn), and the error/done teardown. Previously this
 * function hand-rolled ALL of that, which meant a fix to the turn lifecycle had
 * to be mirrored here by hand.
 *
 * The ONE carve-out is post-turn behavior — `postTurn: "none"` elides
 * auto-commit / auto-push / queue-drain — because the rebase machinery commits
 * via `git rebase --continue` and force-pushes after the whole flow; an
 * auto-commit mid-rebase would corrupt it. The completion signal
 * (`onTurnComplete`) is what lets this multi-turn driver await one resolution
 * turn, run its git step, then dispatch the next.
 */
function runRebaseResolutionTurn(
  deps: RebaseDriverDeps,
  prompt: string,
): Promise<void> {
  const { runner } = deps;

  return new Promise<void>((resolve, reject) => {
    let turnSettled = false;
    // A user (or another system) turn slipped in between rebase iterations —
    // `dispatch` would enqueue rather than start, and `onTurnComplete` would
    // never fire, hanging this promise until the wall-clock timeout. Reject so
    // the conflict loop aborts the in-progress rebase cleanly instead.
    if (runner.running) {
      reject(new ServiceError(409, "Cannot resolve conflicts while an agent turn is in progress"));
      return;
    }

    // docs/146 — signal "real work has started" so the auto-resolve wrapper
    // classifies a downstream throw as a post-spawn error (count it) rather
    // than a pre-spawn defer. The conflict loop only calls this after all
    // pre-flight (fetch, ancestry, base-ref) has passed, so the dispatch
    // boundary IS the spawn boundary.
    deps.onAgentSpawned?.();

    runner.dispatch(prepareDispatch({
      text: prompt,
      agentInterface: undefined,
      activity: "Resolving conflicts...",
      // Elide the post-turn commit/push/PR/drain — the rebase owns committing.
      postTurn: "none",
      // Suppress live-steering for the duration so a concurrent user message
      // is queued (and drained after the flow) rather than injected into the
      // resolution turn and derailing it.
      systemTurn: true,
      execution: undefined,
      images: undefined,
      files: undefined,
      uploads: undefined,
      permissionMode: undefined,
      deliveryId: undefined,
      dictated: undefined,
      onTurnComplete: (outcome) => {
        // The raw callback is NOT once-only: `withSettlement` latches the
        // settlement promise but invokes the chained original on every call,
        // and a runner disposal/abandonment settlement can be followed by a
        // late terminal event from the dying process. A second invocation
        // after the flow's `finally` has released the hold would re-lock an
        // idle runner with no flow left to clear it — latch here.
        if (turnSettled) return;
        turnSettled = true;
        // planning#338 — `finishTurn` cleared the per-turn system-turn flag in the
        // same synchronous call stack that runs this callback. The FLOW still
        // owns the session (more git work, possibly another resolution turn),
        // so re-assert its hold before any await can let a user turn in —
        // unless a displacing turn already claimed the runner (`running`),
        // in which case the flag is that turn's to keep false.
        if (!runner.running) runner.systemTurnInProgress = true;
        if (outcome.status === "completed") {
          resolve();
          return;
        }
        // planning#338 — anything short of `completed` means the conflicted files
        // are NOT reliably resolved: an agent process error (the shared
        // listener already wrote the error row), a no-result exit, `dropped`
        // (runner disposed / queue cleared), or `interrupted` — the user
        // pressed stop, or a newer turn took the agent slot (the production
        // displacement). The pre-planning#338 code resolved on those (`errored`
        // was the only reject), so the driver ran `git add -A && git rebase
        // --continue` over a half-resolved — or someone else's — working tree.
        // Rejecting routes every one of them through the conflict loop's
        // abort-and-rethrow.
        reject(new Error(
          outcome.status === "errored"
            ? "Agent error during rebase conflict resolution"
            : `the conflict-resolution turn ended as "${outcome.status}"${outcome.detail ? ` — ${outcome.detail}` : ""}`,
        ));
      },
    }));
  });
}

// ---------------------------------------------------------------------------
// runAutoResolveAttempt — docs/146 wrapper around runRebaseFlow.
// ---------------------------------------------------------------------------

/** Default wall-clock cap on a single auto-resolve attempt. */
export const AUTO_RESOLVE_ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Wraps `runRebaseFlow` for the auto-conflict-resolve path. (docs/146)
 *
 * Pre-flight gates (don't burn budget):
 *   - dirty tree, in-progress rebase, no GitHub auth → deferred.
 *
 * Translation of `runRebaseFlow`'s outcome:
 *   - `up_to_date` with NO push (GitHub said CONFLICTING but our local view
 *     disagrees, and the remote already has our head) → deferred with
 *     `suppressEmit: true` so the WS layer doesn't flash "rebased then deferred"
 *     after the inner `rebase_complete`.
 *   - `up_to_date` that DID push (the branch held commits origin never saw —
 *     which is why GitHub still said CONFLICTING) → success carrying
 *     `forcePushed`, so the manager arms the settle window for the new head.
 *   - `rebased` / `conflicts_resolved` → success carrying `forcePushed`.
 *   - `ServiceError(409)` from the running-guard → deferred (TOCTOU backstop).
 *   - Any throw BEFORE `onAgentSpawned` fires (fetch failure, ancestry
 *     check, base-ref resolution) → deferred with a synthetic label, so a
 *     network blip doesn't burn budget. Anything thrown AFTER spawn → error
 *     (real work happened).
 *
 * Wall-clock timeout (default 10 min, overridable via `timeoutMs`): if the
 * agent never finishes, this wrapper does the full runner-state teardown
 * `git.rebaseAbort()` alone doesn't cover. See "Timeout teardown" in doc 146.
 *
 * Does NOT emit `auto_resolve_started` / `auto_resolve_result` itself — the
 * manager owns those envelopes and ties them to attempt accounting. The inner
 * `rebase_started` / `rebase_conflicts` / `rebase_complete` / `rebase_aborted`
 * events still fire from `runRebaseFlow` as a side effect.
 */
export async function runAutoResolveAttempt(
  deps: RebaseDriverDeps & {
    /** Wall-clock timeout for the whole attempt. Default 10 min. */
    timeoutMs?: number;
    /** Injectable clock — included for symmetry with the manager but currently unused inside the wrapper. */
    now?: () => number;
  },
  baseBranch: string,
): Promise<AutoResolveResult> {
  const { git, githubAuthManager, runner } = deps;

  // Pre-flight 1: no GitHub auth. The auto-path diverges from doc 094's
  // user-driven flow here — without auth the agent would do real work, the
  // local rebase would succeed, but the force-push silently no-ops while the
  // PR on GitHub still shows CONFLICTING. Burning agent turns on a remote
  // that will never see the result is wasteful; the failure mode is
  // structurally invisible. Pre-flight gate skips the attempt entirely.
  if (!githubAuthManager.authenticated) {
    return { outcome: "deferred", lastError: "no_github_auth", didWork: false };
  }

  // Pre-flight 2: dirty tree. Defensive — shouldn't happen for an idle
  // session, but the auto-path must NEVER stash silently (a stash here would
  // surprise the user, and `git stash pop` on top of a rebase is a hazard).
  try {
    const clean = await git.isClean();
    if (!clean) {
      return { outcome: "deferred", lastError: "dirty_tree", didWork: false };
    }
  } catch (err) {
    return { outcome: "deferred", lastError: `is_clean_failed: ${getErrorMessage(err)}`, didWork: false };
  }

  // Pre-flight 3: stale rebase from a previous orchestrator crash mid-flight.
  // `runRebaseFlow` would call `git.rebase(baseRef)` which fails when a
  // rebase is already in progress. Abort and defer; the next poll retries
  // from a clean state without burning budget.
  try {
    if (await git.isRebaseInProgress()) {
      try { await git.rebaseAbort(); } catch { /* may already be aborted */ }
      // planning#146: the abort above ran as root and may have re-rooted `.git` +
      // worktree; hand the whole workspace back so the next agent op isn't
      // blocked on a root-owned tree.
      handWorkspaceBackToWorker(runner.sessionDir);
      return { outcome: "deferred", lastError: "stale_rebase", didWork: false };
    }
  } catch (err) {
    return { outcome: "deferred", lastError: `is_rebase_in_progress_failed: ${getErrorMessage(err)}`, didWork: false };
  }

  // `didSpawn` flips true inside `runRebaseResolutionTurn` via the
  // `onAgentSpawned` callback. Used to classify a downstream throw: pre-spawn
  // → deferred (no budget burn); post-spawn → error (real work happened).
  let didSpawn = false;
  const wrappedDeps: RebaseDriverDeps = {
    ...deps,
    onAgentSpawned: () => { didSpawn = true; },
  };

  const timeoutMs = deps.timeoutMs ?? AUTO_RESOLVE_ATTEMPT_TIMEOUT_MS;

  // Wall-clock timeout. Resolves the outer promise early with an error
  // outcome and tears down all the runner state `git.rebaseAbort()` alone
  // doesn't cover. Without the teardown, the session is left with
  // `running = true` and a zombie agent ref, blocking every subsequent user
  // turn until the orchestrator restarts.
  let settled = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<AutoResolveResult>((resolve) => {
    timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      void (async () => {
        // 1. Kill the in-flight agent process.
        try { runner.getAgent()?.kill(); } catch { /* defensive */ }
        // 2. Clear the agent ref so the next turn doesn't pick up the dead reference.
        runner.setAgent(null);
        // 3. Reset running flag; the listener's normal `agent_result` reset
        //    never runs because we killed before completion.
        runner.running = false;
        // 4. Clear system-turn flag so live steering is allowed again.
        runner.systemTurnInProgress = false;
        // 5. Emit "idle" so any deferred subscribers re-evaluate.
        runner.onAgentFinished();
        // 6. Abort the underlying git rebase (best-effort).
        try { await git.rebaseAbort(); } catch { /* may already be aborted */ }
        // 7. Surface a `rebase_aborted` so the UI clears the rebase banner
        //    doc 094 raised. The inner driver doesn't emit this on our
        //    timeout path because it never gets the chance.
        runner.emitMessage({ type: "rebase_aborted", sessionId: runner.sessionId });
        resolve({ outcome: "error", lastError: "timeout", didWork: true });
      })();
    }, timeoutMs);
  });

  // The actual flow. Wrap the throwing/early-exit cases into the AutoResolveResult shape.
  const flowPromise = (async (): Promise<AutoResolveResult> => {
    try {
      const result = await runRebaseFlow(wrappedDeps, baseBranch);
      if (result.status === "up_to_date" && !result.forcePushed) {
        // GitHub said CONFLICTING; our local view says HEAD already contains
        // every commit in base, AND the remote already has that head. Races
        // between GraphQL mergeability recompute and our local fetch. Suppress
        // the `auto_resolve_result deferred` emit on this specific path —
        // `runRebaseFlow` already emitted `rebase_complete { forcePushed: false }`
        // and a contradicting `auto_resolve_result deferred` would flash
        // "rebased then deferred" in the UI.
        return { outcome: "deferred", didWork: false, suppressEmit: true };
      }
      // An up-to-date flow that DID push is a success, not a deferral. Reporting
      // it as deferred would hand `writeBack` `pushed: false`, so it would skip
      // the settle window and leave the arbiter's await-fresh-signal unarmed —
      // and the next poll, still holding GitHub's pre-push CONFLICTING verdict,
      // would re-fire against a head that no longer has the conflict. That is
      // the docs/146 spin, which `writeBack`'s own comment records as having
      // been reached once before "through the one path that used to hard-code
      // `false`".
      // up_to_date-with-push / rebased / conflicts_resolved
      return { outcome: "success", forcePushed: result.status !== "aborted" && "forcePushed" in result ? result.forcePushed : false, didWork: true };
    } catch (err) {
      // 409 from the running-guard. Pre-spawn, no real work; defer.
      if (err instanceof ServiceError && err.statusCode === 409) {
        return { outcome: "deferred", didWork: false };
      }
      // Pre-spawn throw (fetch failure, ancestry check, base-ref resolution).
      // Defer rather than count against budget — a network blip should not
      // exhaust the per-session attempts.
      if (!didSpawn) {
        return { outcome: "deferred", lastError: getErrorMessage(err), didWork: false };
      }
      // Post-spawn throw. Real work happened (one or more agent turns).
      // Ensure the underlying rebase is aborted before returning — without
      // this cleanup the next attempt's stale-rebase pre-flight defers and
      // the per-session budget never reaches the cap. `runRebaseFlow` aborts
      // on its own internal paths (lockfile/abort/continue failures) but a
      // bubbled-up agent process error escapes before those run.
      try { await git.rebaseAbort(); } catch { /* may already be aborted */ }
      return { outcome: "error", lastError: getErrorMessage(err), didWork: true };
    }
  })();

  const winner = await Promise.race([flowPromise, timeoutPromise]);
  settled = true;
  if (timeoutHandle) clearTimeout(timeoutHandle);
  // planning#146: on the timeout path the teardown's `git.rebaseAbort()` ran as root
  // (and resolves the race only after it completes), so `.git` + worktree can be
  // left root-owned without `runRebaseFlow`'s finally having the last write. Hand
  // the whole workspace back here too — redundant but harmless on the normal
  // path. No-op when the flag is unset.
  //
  // Deliberately NOT paired with a `restoreLfsAfterTreeRewrite` (nikzlabs/shipit#2349),
  // unlike every other rewrite site: killing the agent makes the resolution turn
  // reject, so `runRebaseFlow`'s own finally aborts and restores against this
  // same clone. A second pull here would race that one for no added coverage.
  handWorkspaceBackToWorker(runner.sessionDir);
  try {
    await deps.drainQueue?.();
  } catch (err) {
    console.error("[auto-resolve] drainQueue failed:", err);
  }
  return winner;
}
