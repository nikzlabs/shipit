/**
 * The post-turn auto-push — the debounce timer that carries it, and the single
 * body both schedulers run.
 *
 * ## Why the timer is not on the runner
 *
 * It used to be a `setTimeout` handle stored on the session's runner, which gave
 * one push three ways to disappear, none of them about git or GitHub:
 *
 *  1. `scheduleAutoPush` resolved a runner (registry, else the per-connection
 *     `attachedRunner`) and `return`ed **silently** when both were empty. From
 *     the 2026-08-10 orchestrator log: a commit line at 17:38:52.725 with no
 *     push line after it, and no error anywhere.
 *  2. `dispose()` called `clearPushTimer()`, so an already-armed push was not
 *     merely raced by teardown — it was cancelled by it.
 *  3. Nulling the handle at fire time dropped the runner's own "a push is
 *     pending" signal at the exact moment the network call started.
 *
 * `post-turn-hold.ts` closed the window that made (2) and (3) fire in practice:
 * a runner in a turn's terminal sequence now declines a non-forced `dispose()`.
 * This module removes the coupling that made them *possible*. The commit runs
 * against the session directory on the host and needs no runner; so does the
 * push. What the runner is still needed for is (a) rendering the outcome to
 * attached viewers and (b) knowing it is not idle — so the scheduler holds the
 * runner's post-turn hold from the moment it arms a push until that push has
 * finished, and a runner that is gone downgrades the reporting rather than
 * cancelling the work.
 *
 * ## Loud when it cannot run
 *
 * Every path that ends without a push says so, in the session's log ring and on
 * the server log. `services/merged-push-guard.ts` is the precedent, and its own
 * comment states the reason: *"The refusal is loud by construction — it is the
 * *silence* that made this a user-reported bug twice."* That applies with more
 * force here, because unlike the merged-branch guard this failure is not a
 * decision anyone made.
 *
 * That claim was once only half true, and the missing half cost two days of
 * undetected data loss. `broadcastLog` writes to the durable log store and the
 * in-memory ring — it makes NO console call — so an operator reading
 * `docker logs` saw a commit line followed by nothing at all, which reads as a
 * push that succeeded. Every `report()` now carries a `console.warn` of its own,
 * as does the non-fast-forward branch and each of `pushToOrigin`'s two skips.
 *
 * ## A rejected push is a transcript notice, not just a log line
 *
 * The incident (2026-08-14/15, session 7bc72326): a branch was rebased onto a
 * fresh base after a merge — which ShipIt's own agent instructions prescribe —
 * so the local history no longer fast-forwarded onto the remote. The unforced
 * post-turn push was rejected on every turn for ten hours. Nine commits stayed
 * local; two pull requests then merged at the state of the last SUCCESSFUL push,
 * seven and two commits behind. One of the resulting PR titles records the
 * damage: "…and five slice records the merge left behind."
 *
 * Refusing to force a divergence is right, and stays. What was wrong is that the
 * refusal reached neither surface that could act on it: the log-ring line lives
 * in a panel nobody had open, and the `git_push_rejected` WS message is
 * transient client state. So a rejection now also leaves a PERSISTED transcript
 * notice, exactly as the merged-push guard does — naming the branch, the reason,
 * and the two commands that actually ship the work.
 *
 * **One notice per divergence EPISODE, not per rejection.** Nine identical
 * notices is noise that trains the reader to skip the tenth; the episode flag is
 * cleared by the next successful push, so a divergence that is healed (by
 * `gh pr create`'s force-push, by a rebase, by the user) and later recurs gets a
 * fresh notice rather than being suppressed forever. Every rejection still
 * reaches the log ring and the server log — the suppression is on the transcript
 * only.
 *
 * ## …unless ShipIt itself is mid-rewrite, in which case it is not news
 *
 * The 2026-08-17 incident (session 590c19aa): a turn committed, which armed this
 * push; 1.2s later the auto-conflict-resolve-on-idle path started a rebase; the
 * debounced push fired 4s into it and produced the full alarming notice above —
 * recovery commands, `shipit branch reset-to-base --force` and all — for a
 * branch the rebase driver force-pushed 23 seconds later and which was fine
 * throughout.
 *
 * **What the push actually did is worth stating, because it is not what "the
 * branch diverged" suggests** (reproduced in a scratch repo, git 2.x, the
 * pinned simple-git): mid-rebase the workspace is on a DETACHED HEAD, so
 * `git status --porcelain -b` reports `## HEAD (no branch)` and
 * `GitManager.getCurrentBranch()` returns the literal `"HEAD"`. `pushToOrigin`
 * then runs `git push origin HEAD --set-upstream`, which git refuses outright —
 * *"The destination you provided is not a full refname"* — and ends with
 * `error: failed to push some refs`. That last line is one of
 * `isNonFastForwardError`'s four patterns, so a push that never reached the
 * remote at all was reported as a divergence. The session branch was never
 * even the target.
 *
 * ## …and the same misreport again, from the other side (2026-08-18)
 *
 * Session b77e02fe, `nicolasalt/reward-tag`: two turns' commits stayed local,
 * both announced as *"Auto-push rejected: branch has diverged from remote"*.
 * There was no divergence — `git ls-remote` showed the remote tip still at
 * ShipIt's own last successful push, and `git merge-base --is-ancestor` exited
 * 0. What actually happened is that the orchestrator's hook-less push sent Git
 * LFS pointers without uploading their objects, and GitHub answered
 * `GH008: unknown Git LFS object` — a rejection ending, once again, in
 * `error: failed to push some refs`. The remedy the notice named (rebase) could
 * not touch it, and the raw stderr reached no surface an operator could read.
 *
 * Two fixes came out of that, one per defect. The upload is now explicit
 * (`shared/git-lfs-push.ts`). And the reading of a push failure is a
 * CLASSIFICATION (`services/git.ts` `classifyPushFailure`) that refuses to
 * assign a class on git's summary line: `failed to push some refs` alone now
 * means `unknown`, which is reported verbatim instead of being interpreted.
 * Every push failure is logged with its class and its full message here, before
 * any branch decides what to make of it.
 *
 * So the auto-push has no business running mid-rebase, exactly as the auto-COMMIT
 * side already concluded (`shared/git.ts` consults `isRebaseInProgress()` and
 * refuses). Two checks, deliberately asymmetric, because the two signals are not
 * interchangeable:
 *
 *  - **Before the push, `git.isRebaseInProgress()` alone.** Exact, and during a
 *    real rebase the push provably cannot do anything useful — there is no
 *    branch for it to target. Costs one `git rev-parse` on a path that is about
 *    to make a network round-trip.
 *  - **At a non-fast-forward rejection, that OR `runner.systemTurnInProgress`.**
 *    The flag is held for the WHOLE rebase flow (planning#338), which is what covers
 *    the gap between `git rebase --continue` finishing and `tryForcePush`
 *    publishing — 2 seconds in the incident, and a window git itself reports as
 *    clean. But the flag is generic: CI auto-fix, wake turns and prepared
 *    dispatch hold it too, and none of those rewrite history. Consulting it
 *    only at a rejection is what keeps that breadth harmless — it can delay a
 *    warning about a push that FAILED, never a push that would have succeeded.
 *
 * A deferred push is RE-ARMED, not dropped. The rebase driver's own force-push
 * usually publishes the commit anyway, but not on the abort path: an aborted
 * rebase restores the pre-rebase branch and pushes nothing, and the commit this
 * timer carries would then have pushed cleanly. Retrying is what keeps that
 * commit from going the way of the nine the incident above cost us. The retry is
 * bounded ({@link MAX_PUSH_DEFERRALS}) so a wedged `systemTurnInProgress` cannot
 * silence the real notice forever — past the cap the rejection is reported
 * normally, and a genuine divergence that arises during a long system turn is
 * delayed by at most that cap. Every deferral still reaches all three log
 * surfaces; only the transcript notice and the client rebase banner are withheld.
 *
 * ## One body, two callers
 *
 * The WS path (`route-registry.ts`) and the system-turn path
 * (`runner-registry-factory.ts`) each used to carry their own copy, and both
 * copies were fail-closed the same way. They now share this one, so a dispatched
 * turn (Fix CI, a child session, `/agent/dispatch`) pushes exactly like a
 * user-typed one — including the post-push CI cadence bump and the invalid-token
 * report, which the system-turn copy silently never did.
 */

import type { GitManager } from "../../shared/git.js";
import type { LogSource } from "../../shared/types.js";
import type { PersistedMessage } from "../chat-history.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import { pushToOrigin, isGitAuthError } from "../git-utils.js";
import { classifyPushFailure, isNonFastForwardError, isRewriteWindowPushFailure } from "./git.js";
import { emitNoticePostTurn } from "../chat-card-persistence.js";
import { agentLogAppend } from "../log-emit.js";
import { getErrorMessage } from "../validation.js";

/**
 * The persisted transcript notice for a push rejected as non-fast-forward. It
 * answers the three questions the user asked during the incident, in order: what
 * happened to my commit, why, and how do I ship it.
 *
 * Plain prose, no markdown emphasis — `MessageList` renders a `notice` as
 * pre-wrapped text (`useMarkdown` is false for notices), so `**bold**` would show
 * up literally. Backticks match the neighbouring merged-push / conflict notices.
 *
 * The branch may be unknown (the rejection came from `git push`, and re-reading
 * the branch afterwards can itself fail), so every mention degrades gracefully
 * rather than printing "undefined".
 *
 * ## Why the remedy is three branches and not one line
 *
 * A remedy the agent is refused when it runs it is the same dead end in a
 * friendlier voice, so each branch was checked against the code that would
 * refuse it. Divergence has two causes with opposite fixes, and this notice's
 * firing condition OVERLAPS a third state that forbids both:
 *
 *  - **The remote is ahead** — an ordinary reconcile, `git pull --rebase`.
 *  - **This branch's history was rewritten** — pulling would drag the replaced
 *    history back in, so the fix is `--force-with-lease`.
 *  - **…and the session's pull request has already merged.** A branch rebased
 *    off a merged tip still has `mergedAt` set (the docs/202 re-arm clears it
 *    only later), which arms `SHIPIT_GUARD_DESTRUCTIVE_GIT=1` and makes
 *    `docker/agent-hooks/block-branch-ops.mjs` block a hand-rolled
 *    `--force-with-lease` outright. The sanctioned command is
 *    `shipit branch reset-to-base` — but a PLAIN one refuses here too, with
 *    `head-moved` (`services/pre-turn-reset.ts`), because new commits sit on top
 *    of the merged SHA. `--force --reason "<why>"` is the documented escape for
 *    exactly this shape (CLAUDE.md post-turn invariant 4), so that is what the
 *    notice names.
 *
 * `gh pr create` is named with its condition attached rather than as a blanket
 * escape hatch: it `forcePush`es ONLY when re-arming past a merged pull request
 * (`services/github.ts`). Against an OPEN pull request it uses a plain
 * `git.push`, which a diverged branch rejects exactly as the auto-push did.
 */
export function formatDivergedPushNotice(branch: string | null): string {
  const named = branch ? ` ${branch}` : "";
  const ref = branch ? `origin ${branch}` : "origin <branch>";
  return (
    `Not pushed — this session's branch${named} has diverged from its remote.\n\n`
    + `The commit is safe in this session's local history, but the push was rejected as `
    + `non-fast-forward: the remote branch carries commits this branch does not, or this `
    + `branch's history was rewritten (a rebase or a reset onto a fresh base). ShipIt never `
    + `force-pushes automatically, so the branch on GitHub stays frozen at its last successful `
    + `push — and a pull request on it would merge WITHOUT this commit. Every further commit `
    + `stays local too, until the divergence is resolved.\n\n`
    + `To ship it, take the case that applies:\n\n`
    + `1. The remote simply has commits this branch does not — reconcile with `
    + `\`git pull --rebase ${ref}\`, and the next turn's push lands.\n`
    + `2. This branch's history was rewritten on purpose — publish it with `
    + `\`git push --force-with-lease ${ref}\`.\n`
    + `3. This session's pull request has ALREADY MERGED — ShipIt blocks a hand-rolled `
    + `force-push in that state, and a plain \`shipit branch reset-to-base\` refuses it too `
    + `(\`head-moved\`) once new commits sit on the merged tip. Use `
    + `\`shipit branch reset-to-base --force --reason "<why>"\`, then re-apply this work on the `
    + `fresh base and open a new pull request.\n\n`
    + `Note that \`gh pr create\` force-pushes only when it re-arms past a merged pull request; `
    + `against an open one it uses a plain push and is rejected the same way.`
  );
}

/**
 * How long to wait before retrying a push that was rejected while ShipIt's own
 * history rewrite was still in flight.
 *
 * Deliberately longer than the post-turn debounce: the deferred push is a
 * BACKSTOP (the rebase driver's own force-push publishes the commit on every
 * path except an abort), so latency costs nothing, while a 5s retry against a
 * ten-minute conflict-resolution turn would put a hundred identical lines in the
 * operator's log — the noise this module's own dedup reasoning warns about.
 */
export const PUSH_DEFER_RETRY_MS = 30_000;

/**
 * How many times one push may be deferred before its rejection is reported as an
 * ordinary divergence. At {@link PUSH_DEFER_RETRY_MS} that is ~15 minutes —
 * comfortably past `AUTO_RESOLVE_ATTEMPT_TIMEOUT_MS` (10 min), the longest
 * legitimate rewrite window there is.
 *
 * The cap exists because the cheap signal is a mutable flag: a
 * `systemTurnInProgress` that never gets cleared would otherwise downgrade every
 * future rejection on that session to a log line, which is this module's
 * original bug wearing a hat. Past the cap we go loud — a spurious warning about
 * a healthy branch is recoverable, a swallowed one is not.
 */
export const MAX_PUSH_DEFERRALS = 30;

/** What the push body needs. All session-keyed — none of it is runner-scoped. */
export interface AutoPushDeps {
  /** Debounce window before an armed push fires. */
  debounceMs: number;
  githubAuthManager: {
    readonly authenticated: boolean;
    markTokenInvalid(reason: string): Promise<boolean>;
  };
  /**
   * The session's live runner, when it still has one. Used to render the outcome
   * to attached viewers and to hold the post-turn lease — never to decide
   * whether the push happens.
   */
  getRunner: (sessionId: string) => SessionRunnerInterface | null | undefined;
  /**
   * Per-session log ring. Runner-independent and replayed to a viewer that
   * reconnects later, so this is what makes a push outcome durable when the
   * container the turn ran in is already gone.
   */
  broadcastLog: (sessionId: string, source: LogSource, text: string) => void;
  /**
   * Durable chat history — only `append` is used. A rejected push fires from the
   * debounce timer AFTER the turn has finalized, so the notice takes the
   * append-a-final-row path (`emitNoticePostTurn`); an in-progress persist here
   * would revive the finished turn as a duplicate `in_progress=1` row set that
   * the next turn's `replaceInProgress` deletes.
   *
   * Required, not optional: an optional persist dep is exactly how a transcript
   * card ships emit-only, which is the bug class this notice exists to end.
   */
  chatHistory: { append(sessionId: string, message: PersistedMessage): unknown };
  /**
   * Bump this session's repo to fast PR-status cadence after a push lands — CI
   * is about to register. Optional so tests can leave it out.
   */
  notifyAutoPush?: ((sessionId: string) => void) | undefined;
}

export interface AutoPushScheduler {
  /**
   * Arm (or re-arm) the debounced push for `sessionId`. A commit with no session
   * id — which should not happen on the post-turn path — is reported rather than
   * dropped on the floor.
   */
  schedule(git: GitManager, sessionId: string | undefined): void;
  /**
   * Drop a pending push. Called after a *synchronous* push has already replaced
   * it (`agentCreatePr`), never on runner teardown.
   */
  cancel(sessionId: string | undefined): void;
  /** Drop every pending push. Shutdown only. */
  cancelAll(): void;
  /** Is a push armed for this session? Backs `agentBusy`'s pending-push half. */
  pending(sessionId: string): boolean;
}

export function createAutoPushScheduler(deps: AutoPushDeps): AutoPushScheduler {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Sessions whose current divergence episode has already produced a transcript
   * notice. Cleared by the next successful push — the auto-push here, and the
   * synchronous `gh pr create` push via `cancel` — so a healed-then-recurring
   * divergence is notified again rather than suppressed for the session's life.
   *
   * Two bounded imprecisions, both stated rather than engineered away. It holds
   * one string per session that diverged in this process's lifetime and is not
   * pruned on session teardown (the scheduler has no teardown hook, and the cost
   * is a session id). And it does not survive an orchestrator restart, so a
   * still-standing divergence is notified once more after one — which is the
   * safe direction: a repeated warning about a real problem, not a swallowed one.
   */
  const notifiedDiverged = new Set<string>();
  /**
   * How many times the current push has been deferred because a history rewrite
   * was in flight. Cleared by the three outcomes that END a rewrite window — a
   * push that landed, a rejection reported as a real divergence, an explicit
   * `cancel` — so the budget is per window rather than per session lifetime.
   *
   * One bounded imprecision, stated rather than engineered away: a push that
   * fails for some OTHER reason (the remote hung up, an invalid token) leaves
   * the count standing, so the next rewrite window inherits a smaller budget.
   * That errs toward reporting a divergence sooner, which is the safe direction
   * for a counter whose only job is to stop a wedged flag from suppressing one.
   */
  const deferrals = new Map<string, number>();

  /**
   * Say what happened, whether or not anyone is attached — on all three
   * surfaces. The log ring is the durable half (a viewer that reconnects still
   * finds it); `emitMessage` is the live half and is simply skipped when the
   * runner is gone; `console.warn` is the operator's half, and its absence is
   * what made this bug invisible in `docker logs` for two days.
   *
   * Each surface is isolated, because they fail independently and this function
   * is the FIRST thing the divergence path calls. Unisolated, a throwing log
   * ring or a wedged viewer transport aborted the branch before it reached the
   * persisted notice — restoring the exact invisibility this module exists to
   * end, in the one situation where a reporting surface is already unhealthy.
   * `console.warn` runs first for the same reason: it is the surface with the
   * fewest ways to fail.
   */
  const report = (sessionId: string, text: string): void => {
    console.warn(`[auto-push] ${sessionId}: ${text}`);
    try {
      deps.broadcastLog(sessionId, "server", text);
    } catch (err) {
      console.error(`[auto-push] ${sessionId}: could not write to the session log ring:`, err);
    }
    try {
      deps.getRunner(sessionId)?.emitMessage(agentLogAppend("server", text));
    } catch (err) {
      console.error(`[auto-push] ${sessionId}: could not emit to attached viewers:`, err);
    }
  };

  /**
   * Release the post-turn hold this session's pending push took out when it was
   * armed. Unbalanced ends are a no-op in `PostTurnHold`, so a runner that was
   * disposed and rebuilt under us cannot have its successor's hold unwound.
   */
  const releaseHold = (sessionId: string): void => {
    deps.getRunner(sessionId)?.endPostTurnWork();
  };

  /**
   * Drop the armed timer and give back its hold. Used by `schedule` to REPLACE a
   * pending push, which is why it must not touch `notifiedDiverged` — re-arming
   * happens once per turn, so clearing the episode there would defeat the dedup
   * entirely and put an identical notice after every commit.
   */
  const clearTimer = (sessionId: string | undefined): void => {
    if (!sessionId) return;
    const timer = timers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    timers.delete(sessionId);
    releaseHold(sessionId);
  };

  /**
   * The PUBLIC cancel, which means something narrower than "drop the timer": a
   * synchronous push has already replaced this one (`agentCreatePr` →
   * `dropPendingAutoPush`). That push may have been a `forcePush` that HEALED
   * the divergence, so the episode ends here too — otherwise the next genuine
   * divergence is silently suppressed, which is this bug wearing a hat. The
   * timer is dropped whether or not one was armed, hence the unconditional
   * `delete` rather than `clearTimer`'s early return.
   */
  const cancel = (sessionId: string | undefined): void => {
    if (!sessionId) return;
    clearTimer(sessionId);
    notifiedDiverged.delete(sessionId);
    deferrals.delete(sessionId);
  };

  /**
   * Arm the push timer and take the post-turn hold that keeps the session alive
   * for it. Shared by the post-turn arm (`schedule`, at the debounce) and the
   * rewrite-window retry (`runAutoPush`, at {@link PUSH_DEFER_RETRY_MS}) so a
   * deferred push is armed EXACTLY like an ordinary one — same lease discipline,
   * same reporting backstop.
   *
   * The re-arm from inside the timer body is hold-neutral: this call takes a
   * fresh hold, and the firing timer's own `finally` releases the one it was
   * armed with. `PostTurnHold` counts, so the two cannot get out of step.
   */
  const arm = (git: GitManager, sessionId: string, delayMs: number): void => {
    clearTimer(sessionId);
    // Held from ARM, not from fire: the debounce window is exactly when the
    // idle enforcer used to reclaim the session out from under a commit that
    // had already landed. Released in the timer's `finally` below, and bounded
    // by `POST_TURN_HOLD_MAX_MS` so a wedged push cannot pin the container.
    deps.getRunner(sessionId)?.beginPostTurnWork();
    timers.set(
      sessionId,
      setTimeout(() => {
        timers.delete(sessionId);
        void runAutoPush(git, sessionId)
          // Backstop, not the ordinary path — `runAutoPush` handles its own
          // failures. Without it a throw from the reporting itself (a runner
          // whose `emitMessage` fails, a listener on the token-invalidation
          // event) becomes an unhandled rejection routed to the process-wide
          // handler, which is precisely the swallowed-in-the-logs outcome this
          // module exists to end.
          .catch((err: unknown) => {
            console.error(`[auto-push] ${sessionId}: reporting the push outcome failed:`, err);
          })
          .finally(() => releaseHold(sessionId));
      }, delayMs),
    );
  };

  return {
    schedule(git: GitManager, sessionId: string | undefined): void {
      if (!sessionId) {
        // No session id means no way to key the timer, log the outcome, or name
        // the session in a warning — but the commit it belongs to already
        // landed, so this must not be silent.
        console.warn(
          "[auto-push] skipped — the post-turn commit was made with no session id,"
          + " so its branch stays local until the next push",
        );
        return;
      }
      arm(git, sessionId, deps.debounceMs);
    },
    cancel,
    cancelAll(): void {
      for (const sessionId of [...timers.keys()]) cancel(sessionId);
      notifiedDiverged.clear();
      deferrals.clear();
    },
    pending(sessionId: string): boolean {
      return timers.has(sessionId);
    },
  };

  /**
   * Is git mid-rebase right now? Exact, and the only signal safe to consult
   * BEFORE a push, because it is the only one that guarantees the push cannot
   * succeed (detached HEAD — see the module docstring).
   *
   * Fails toward LOUD: a probe that throws (an unreadable `.git`, a stub without
   * the method) means "cannot tell", and the module's whole thesis is that an
   * unexplained missing push must be visible.
   */
  async function rebaseInProgress(git: GitManager, sessionId: string): Promise<boolean> {
    try {
      return await git.isRebaseInProgress();
    } catch (err) {
      console.warn(`[auto-push] ${sessionId}: could not check for an in-flight rebase:`, err);
      return false;
    }
  }

  /**
   * Hold this push back because a history rewrite is in flight, and arm a retry.
   * Returns false — meaning "not deferred, carry on" — when the retry budget for
   * this window is spent, so the caller falls through to its ordinary handling.
   *
   * One helper for both call sites (pre-push and at a rejection) so the budget,
   * the wording and the re-arm cannot drift apart.
   */
  async function deferForRewrite(git: GitManager, sessionId: string): Promise<boolean> {
    const deferred = (deferrals.get(sessionId) ?? 0) + 1;
    // Counted even once it is over budget, and NOT reset here. Both call sites
    // share this counter, so a cap that cleared itself on the way out would let
    // the pre-push check spend the budget, hand the push to the rejection check,
    // and have that start a fresh one — deferring forever in a loop, which is
    // the swallowed-push outcome the cap exists to prevent. Only an outcome that
    // ENDS the window clears it.
    deferrals.set(sessionId, deferred);
    if (deferred > MAX_PUSH_DEFERRALS) {
      // The window never closed. Something is wedged — stop deferring and let
      // the caller report whatever it was about to report. Said once, at the
      // moment the budget runs out, rather than on every later attempt.
      if (deferred === MAX_PUSH_DEFERRALS + 1) {
        report(
          sessionId,
          `A history rewrite has been in flight for ${MAX_PUSH_DEFERRALS} deferred pushes `
          + "— no longer holding this push back.",
        );
      }
      return false;
    }
    // Quieter wording, same three surfaces. Going silent here is what the whole
    // module argues against: an operator reading `docker logs` must still see
    // that the commit has not reached origin yet.
    report(
      sessionId,
      "Push deferred — this session's branch is being rewritten (a rebase is in flight), so a push "
      + `now cannot land. Retrying in ${Math.round(PUSH_DEFER_RETRY_MS / 1000)}s `
      + `(attempt ${deferred} of ${MAX_PUSH_DEFERRALS}).`,
    );
    arm(git, sessionId, PUSH_DEFER_RETRY_MS);
    return true;
  }

  async function runAutoPush(git: GitManager, sessionId: string): Promise<void> {
    if (!deps.githubAuthManager.authenticated) {
      // Legitimate on an install with no GitHub connected — but the commit is
      // local-only and nothing else says so, which is the whole bug class this
      // module was written for. One line, named, on every occurrence.
      console.warn(
        `[auto-push] ${sessionId}: not pushed — GitHub is not connected.`
        + " The commit stays in this session's local history.",
      );
      return;
    }
    // Mid-rebase there is no branch to push (detached HEAD), so the attempt can
    // only fail — and its failure text ends in "failed to push some refs", which
    // `isNonFastForwardError` matches, which is how a push that never reached the
    // remote came to be reported as a diverged branch. Skip it and retry.
    if (await rebaseInProgress(git, sessionId) && await deferForRewrite(git, sessionId)) return;
    try {
      // The `onSkip` callback closes the module's last fully silent exit: both
      // of `pushToOrigin`'s null returns used to land on a bare `if (!branch)
      // return;`, which said nothing anywhere. Named separately because the two
      // mean very different things — "no origin" is normal for a session with no
      // remote, "no branch" means a detached HEAD and is a real anomaly.
      const branch = await pushToOrigin(git, (reason) => {
        report(
          sessionId,
          reason === "no-origin"
            ? "Not pushed: this session's workspace has no `origin` remote. The commit stays in local history."
            : "Not pushed: the workspace has no current branch (detached HEAD). The commit stays in local history.",
        );
      });
      if (!branch) return;
      // A push landed, so whatever divergence there was is over — the next one
      // gets its own notice, and the next rewrite window its own retry budget.
      notifiedDiverged.delete(sessionId);
      deferrals.delete(sessionId);
      deps.getRunner(sessionId)?.emitMessage({
        type: "github_push_result",
        success: true,
        message: `Auto-pushed to origin/${branch}`,
        branch,
      });
      // A push just landed → CI is about to register. Bump this session's repo
      // to fast cadence for the post-push window so the first non-none check is
      // observed quickly. The poller re-arms the supervisor if the gate was
      // already open (a closed tab keeps the supervisor paused; the user will
      // see fresh data on their next visit via forceRefreshSession).
      deps.notifyAutoPush?.(sessionId);
    } catch (err) {
      // The raw failure, named and complete, BEFORE any branch decides what to
      // make of it. In the 2026-08-18 LFS incident the stderr git actually
      // produced (`GH008: unknown Git LFS object`) reached no surface an
      // operator could read — only the interpretation did, and it was wrong.
      const failure = classifyPushFailure(err);
      console.error(
        `[auto-push] ${sessionId}: push failed [${failure}]: ${getErrorMessage(err)}`,
      );
      // Is the rejection OURS, and still in flight? Two shapes reach here: a
      // rebase that started between the pre-push check and the push, and — the
      // one only the flag can see — the seconds between `git rebase --continue`
      // finishing and the driver's own force-push publishing the rewritten
      // history. Both are healed by the flow that caused them and are nothing
      // for the user to act on, so retry rather than warn. The generic flag is
      // safe HERE and nowhere earlier: this push has already failed, so
      // consulting it can only delay a warning, never a push.
      if (isRewriteWindowPushFailure(err)) {
        const rewriting =
          deps.getRunner(sessionId)?.systemTurnInProgress === true
          || await rebaseInProgress(git, sessionId);
        if (rewriting && await deferForRewrite(git, sessionId)) return;
      }
      if (isNonFastForwardError(err)) {
        deferrals.delete(sessionId);
        // Branch has diverged. Three surfaces, three different jobs:
        //   - `report` — the log ring (durable, replayed to a late viewer) and
        //     the server log. EVERY rejection, so the operator sees the run.
        //   - `git_push_rejected` — transient client state that drives the
        //     rebase banner. Every rejection too; the client owns its lifetime.
        //   - the persisted notice — the transcript, ONCE per episode.
        report(
          sessionId,
          "Auto-push rejected: branch has diverged from remote. Rebase needed to update.",
        );
        try {
          deps.getRunner(sessionId)?.emitMessage({
            type: "git_push_rejected",
            reason: "non_fast_forward",
            message: "Branch has diverged from remote. Rebase needed to update.",
          });
        } catch (emitErr) {
          // Isolated for the same reason `report` isolates its two surfaces: the
          // rebase banner is the LEAST durable of the three, and it sits ahead of
          // the persisted notice. A wedged transport must not cost the row.
          console.error(`[auto-push] ${sessionId}: could not emit git_push_rejected:`, emitErr);
        }
        if (!notifiedDiverged.has(sessionId)) {
          notifiedDiverged.add(sessionId);
          // Best-effort: the push already failed, so re-reading the branch may
          // fail too. The notice degrades to an unnamed branch rather than
          // being lost — it is the whole point of this path.
          let branch: string | null = null;
          try {
            branch = await git.getCurrentBranch();
          } catch { /* notice names no branch */ }
          const runner = deps.getRunner(sessionId);
          try {
            emitNoticePostTurn(
              // Fires from the debounce timer, so the runner may already be
              // gone. The append is the half that matters; the emit is the
              // live-viewer nicety and is simply skipped.
              //
              // Isolated because `emitNoticePostTurn` emits BEFORE it appends,
              // so an unguarded throw from a wedged viewer transport would cost
              // the durable row — losing the notice on precisely the sessions
              // whose live channel is already broken.
              (m) => {
                try {
                  runner?.emitMessage(m);
                } catch (emitErr) {
                  console.error(`[auto-push] ${sessionId}: could not emit the diverged-push notice:`, emitErr);
                }
              },
              deps.chatHistory,
              sessionId,
              formatDivergedPushNotice(branch),
              "warn",
            );
          } catch (noticeErr) {
            // Never let the notice cost the log line or the lease release. Also
            // un-mark the episode so the next rejection retries the notice
            // rather than inheriting a flag set for a notice that never landed.
            notifiedDiverged.delete(sessionId);
            console.error(`[auto-push] ${sessionId}: diverged-push notice failed:`, noticeErr);
          }
        }
        return;
      }
      const errMsg = getErrorMessage(err);
      // Token expired/revoked — mark the stored credential invalid so the SSE
      // broadcast clears the GitHub auth state on every connected client and
      // surfaces a toast pointing back to Settings → GitHub. Without this the
      // failure would only be visible as a "log_entry" in the session's Logs
      // panel — the same swallow-in-the-logs path the user complained about.
      if (isGitAuthError(err)) {
        // `markTokenInvalid` verifies the token against the GitHub API and then
        // emits `token_invalid`, so it is a network call that can reject and a
        // listener that can throw. Its failure must not cost the user the
        // explanation for why their commit is still local — which is what an
        // unguarded `await` here did, by skipping the `report` below entirely.
        let invalidated = false;
        try {
          invalidated = await deps.githubAuthManager.markTokenInvalid(`auto-push failed: ${errMsg}`);
        } catch (markErr) {
          console.error(`[auto-push] ${sessionId}: could not mark the GitHub token invalid:`, markErr);
        }
        report(
          sessionId,
          invalidated
            ? "Auto-push failed: your GitHub token is invalid or expired. Sign in again in Settings → GitHub."
            : `Auto-push failed: ${errMsg}`,
        );
        return;
      }
      if (failure === "lfs") {
        // The remote has the pointers' commits but not the objects. ShipIt now
        // uploads them itself before every push (`shared/git-lfs-push.ts`), so
        // reaching here means that upload failed — name LFS rather than let the
        // reader read `pre-receive hook declined` as branch protection.
        report(
          sessionId,
          "Auto-push rejected: the remote refused the push because its Git LFS objects were not "
          + "uploaded (GH008). The commit stays in this session's local history. Run "
          + "`git lfs push origin HEAD` in the terminal, then push again. "
          + `Git said: ${errMsg}`,
        );
        return;
      }
      report(
        sessionId,
        errMsg.includes("workflow")
          ? "Auto-push failed: your GitHub token needs the `workflow` scope to push changes to GitHub Actions workflow files. Update your token at https://github.com/settings/tokens."
          // The class is in the user-visible line too: it is what tells a reader
          // whether the message below is a divergence, a credential, or neither.
          : `Auto-push failed (${failure}): ${errMsg}`,
      );
    }
  }
}
