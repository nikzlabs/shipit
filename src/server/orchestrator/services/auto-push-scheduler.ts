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
import type { SessionRunnerInterface } from "../session-runner.js";
import { pushToOrigin, isGitAuthError } from "../git-utils.js";
import { isNonFastForwardError } from "./git.js";
import { agentLogAppend } from "../log-emit.js";
import { getErrorMessage } from "../validation.js";

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
   * Say what happened, whether or not anyone is attached. The log ring is the
   * durable half (a viewer that reconnects still finds it); `emitMessage` is the
   * live half and is simply skipped when the runner is gone.
   */
  const report = (sessionId: string, text: string): void => {
    deps.broadcastLog(sessionId, "server", text);
    deps.getRunner(sessionId)?.emitMessage(agentLogAppend("server", text));
  };

  /**
   * Release the post-turn hold this session's pending push took out when it was
   * armed. Unbalanced ends are a no-op in `PostTurnHold`, so a runner that was
   * disposed and rebuilt under us cannot have its successor's hold unwound.
   */
  const releaseHold = (sessionId: string): void => {
    deps.getRunner(sessionId)?.endPostTurnWork();
  };

  const cancel = (sessionId: string | undefined): void => {
    if (!sessionId) return;
    const timer = timers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    timers.delete(sessionId);
    releaseHold(sessionId);
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
      cancel(sessionId);
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
        }, deps.debounceMs),
      );
    },
    cancel,
    cancelAll(): void {
      for (const sessionId of [...timers.keys()]) cancel(sessionId);
    },
    pending(sessionId: string): boolean {
      return timers.has(sessionId);
    },
  };

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
    try {
      const branch = await pushToOrigin(git);
      if (!branch) return;
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
      if (isNonFastForwardError(err)) {
        // Branch has diverged — emit so the client can offer a rebase, and log
        // it either way so a detached session still records the divergence.
        deps.broadcastLog(
          sessionId,
          "server",
          "Auto-push rejected: branch has diverged from remote. Rebase needed to update.",
        );
        deps.getRunner(sessionId)?.emitMessage({
          type: "git_push_rejected",
          reason: "non_fast_forward",
          message: "Branch has diverged from remote. Rebase needed to update.",
        });
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
      report(
        sessionId,
        errMsg.includes("workflow")
          ? "Auto-push failed: your GitHub token needs the `workflow` scope to push changes to GitHub Actions workflow files. Update your token at https://github.com/settings/tokens."
          : `Auto-push failed: ${errMsg}`,
      );
    }
  }
}
