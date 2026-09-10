// Keep push work session-keyed so runner disposal cannot cancel it.
import type { GitManager } from "../../shared/git.js";
import type { LogSource } from "../../shared/types.js";
import type { PersistedMessage } from "../chat-history.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import { pushToOrigin, isGitAuthError } from "../git-utils.js";
import { classifyPushFailure, isNonFastForwardError, isRewriteWindowPushFailure } from "./git.js";
import {
  baseRebaseIsSafe,
  formatDivergedPushNotice,
  measurePushDivergence,
  type PushDivergence,
} from "./push-divergence.js";
import { emitNoticePostTurn } from "../chat-card-persistence.js";
import { agentLogAppend } from "../log-emit.js";
import { getErrorMessage } from "../validation.js";

export const PUSH_DEFER_RETRY_MS = 30_000;
export const MAX_PUSH_DEFERRALS = 30;

export interface AutoPushDeps {
  debounceMs: number;
  githubAuthManager: {
    readonly authenticated: boolean;
    markTokenInvalid(reason: string): Promise<boolean>;
  };
  getRunner: (sessionId: string) => SessionRunnerInterface | null | undefined;
  broadcastLog: (sessionId: string, source: LogSource, text: string) => void;
  chatHistory: { append(sessionId: string, message: PersistedMessage): unknown };
  notifyAutoPush?: ((sessionId: string) => void) | undefined;
  destructiveGitGuarded?: ((sessionId: string) => boolean) | undefined;
}

export interface AutoPushScheduler {
  schedule(git: GitManager, sessionId: string | undefined): void;
  /** Cancel only after a synchronous push has replaced this one. */
  cancel(sessionId: string | undefined): void;
  cancelAll(): void;
  pending(sessionId: string): boolean;
}

export function createAutoPushScheduler(deps: AutoPushDeps): AutoPushScheduler {
  interface ArmedPush {
    timer: ReturnType<typeof setTimeout>;
    // Lease identity only; reporting resolves the current runner.
    runner: SessionRunnerInterface | null;
  }
  const timers = new Map<string, ArmedPush>();
  // Deduplicate until a successful push. Restart permits another notice.
  const notifiedDiverged = new Set<string>();
  // Unrelated push failures retain the count, reducing the next rewrite's budget.
  const deferrals = new Map<string, number>();

  // Isolate reporting surfaces so a broken transport cannot prevent persistence.
  const report = (sessionId: string, text: string, level: "warn" | "info" = "warn"): void => {
    if (level === "info") console.log(`[auto-push] ${sessionId}: ${text}`);
    else console.warn(`[auto-push] ${sessionId}: ${text}`);
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

  // Keep untrusted git text separate from cross-session-safe classification lines.
  const reportGitText = (sessionId: string, errMsg: string): void => {
    report(sessionId, `Git said: ${errMsg}`);
  };

  // Measured output contains only controlled counts; unmeasured reasons can contain git text.
  const describeShape = (shape: PushDivergence): string => {
    if (!shape.measured) {
      return `Divergence shape: could not be measured — ${shape.reason}.`;
    }
    const stale = shape.refreshed ? "" : " (against a remote view that could not be refreshed)";
    const atRisk = shape.behind > 0
      ? ` A force-push would discard ${shape.behind} commit(s) from the remote.`
      : "";
    return [
      `Divergence shape${stale}: ${shape.ahead} commit(s) only in this session, `
      + `${shape.behind} commit(s) only on the remote branch`
      + `${shape.sharedBase ? "" : "; the two histories share no common commit"}.`,
      atRisk,
    ].join("");
  };

  // Estimate before push updates upstream. A stale or custom upstream can differ
  // from origin, so report this as a local measurement, not a count of pushed commits.
  const countPendingCommits = async (git: GitManager, sessionId: string): Promise<number | null> => {
    try {
      return (await git.aheadBehind("@{upstream}"))?.ahead ?? null;
    } catch (err) {
      console.warn(`[auto-push] ${sessionId}: could not count the commits to push:`, err);
      return null;
    }
  };

  const forcePushBlocked = (sessionId: string): boolean => {
    try {
      return deps.destructiveGitGuarded?.(sessionId) === true;
    } catch (err) {
      console.warn(`[auto-push] ${sessionId}: could not read the destructive-git guard state:`, err);
      return false;
    }
  };

  const releaseHold = (runner: SessionRunnerInterface | null): void => {
    runner?.endPostTurnWork();
  };

  // Rearming must not clear divergence deduplication on every turn.
  const clearTimer = (sessionId: string | undefined): void => {
    if (!sessionId) return;
    const armed = timers.get(sessionId);
    if (!armed) return;
    clearTimeout(armed.timer);
    timers.delete(sessionId);
    releaseHold(armed.runner);
  };

  const cancel = (sessionId: string | undefined): void => {
    if (!sessionId) return;
    clearTimer(sessionId);
    notifiedDiverged.delete(sessionId);
    deferrals.delete(sessionId);
  };

  const arm = (git: GitManager, sessionId: string, delayMs: number): void => {
    clearTimer(sessionId);
    // Hold from arm time through completion, and release on this exact runner
    // even if the registry replaces it. Retries take a separate counted lease.
    const runner = deps.getRunner(sessionId) ?? null;
    runner?.beginPostTurnWork();
    timers.set(sessionId, {
      runner,
      timer: setTimeout(() => {
        timers.delete(sessionId);
        void runAutoPush(git, sessionId)
          .catch((err: unknown) => {
            console.error(`[auto-push] ${sessionId}: reporting the push outcome failed:`, err);
          })
          .finally(() => releaseHold(runner));
      }, delayMs),
    });
  };

  return {
    schedule(git: GitManager, sessionId: string | undefined): void {
      if (!sessionId) {
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
      for (const sessionId of [...timers.keys()]) {
        // Shutdown drops unreplaced pushes; report each commit left local.
        console.warn(
          `[auto-push] ${sessionId}: dropping a pending push at shutdown —`
          + " this session's latest commit stays local until its next push.",
        );
        cancel(sessionId);
      }
      notifiedDiverged.clear();
      deferrals.clear();
    },
    pending(sessionId: string): boolean {
      return timers.has(sessionId);
    },
  };

  async function rebaseInProgress(git: GitManager, sessionId: string): Promise<boolean> {
    try {
      return await git.isRebaseInProgress();
    } catch (err) {
      console.warn(`[auto-push] ${sessionId}: could not check for an in-flight rebase:`, err);
      return false;
    }
  }

  async function deferForRewrite(git: GitManager, sessionId: string): Promise<boolean> {
    const deferred = (deferrals.get(sessionId) ?? 0) + 1;
    // Both deferral sites share this count. Resetting on exhaustion would renew
    // the other site's budget and suppress the failure indefinitely.
    deferrals.set(sessionId, deferred);
    if (deferred > MAX_PUSH_DEFERRALS) {
      if (deferred === MAX_PUSH_DEFERRALS + 1) {
        report(
          sessionId,
          `A history rewrite has been in flight for ${MAX_PUSH_DEFERRALS} deferred pushes `
          + "— no longer holding this push back.",
        );
      }
      return false;
    }
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
      console.warn(
        `[auto-push] ${sessionId}: not pushed — GitHub is not connected.`
        + " The commit stays in this session's local history.",
      );
      return;
    }
    if (await rebaseInProgress(git, sessionId) && await deferForRewrite(git, sessionId)) return;
    const pending = await countPendingCommits(git, sessionId);
    const startedAt = Date.now();
    try {
      const branch = await pushToOrigin(git, (reason) => {
        report(
          sessionId,
          reason === "no-origin"
            ? "Not pushed: this session's workspace has no `origin` remote. The commit stays in local history."
            : "Not pushed: the workspace has no current branch (detached HEAD). The commit stays in local history.",
        );
      });
      if (!branch) return;
      notifiedDiverged.delete(sessionId);
      deferrals.delete(sessionId);
      const outcome = pending === null
        ? "the commit count could not be measured."
        : pending === 0
          ? "nothing was ahead of the last known remote tip."
          : `${pending} commit(s) ${pending === 1 ? "was" : "were"} ahead of the last known remote tip.`;
      report(sessionId, `Auto-push completed in ${Date.now() - startedAt}ms: ${outcome}`, "info");
      // Reporting failures after a successful push must not be classified as git failures.
      try {
        deps.getRunner(sessionId)?.emitMessage({
          type: "github_push_result",
          success: true,
          message: `Auto-pushed to origin/${branch}`,
          branch,
        });
      } catch (emitErr) {
        console.error(`[auto-push] ${sessionId}: could not emit the push result to viewers:`, emitErr);
      }
      try {
        deps.notifyAutoPush?.(sessionId);
      } catch (notifyErr) {
        console.error(`[auto-push] ${sessionId}: could not bump the PR poller's cadence:`, notifyErr);
      }
    } catch (err) {
      const failure = classifyPushFailure(err);
      console.error(
        `[auto-push] ${sessionId}: push failed [${failure}]: ${getErrorMessage(err)}`,
      );
      // The generic system-turn flag is checked only after failure: it can delay
      // a warning during rewrite publication, but cannot prevent a valid push.
      if (isRewriteWindowPushFailure(err)) {
        const rewriting =
          deps.getRunner(sessionId)?.systemTurnInProgress === true
          || await rebaseInProgress(git, sessionId);
        if (rewriting && await deferForRewrite(git, sessionId)) return;
      }
      if (isNonFastForwardError(err)) {
        deferrals.delete(sessionId);
        report(
          sessionId,
          "Auto-push rejected: this session's branch and its remote have diverged."
          + " Measuring which side carries what.",
        );
        if (!notifiedDiverged.has(sessionId)) {
          notifiedDiverged.add(sessionId);
          // Log before the bounded fetch; diagnose once per divergence episode.
          const shape = await measurePushDivergence(git);
          report(sessionId, describeShape(shape));
          // The banner can force-push. Do not offer it when remote-only commits are at risk.
          if (baseRebaseIsSafe(shape)) {
            try {
              deps.getRunner(sessionId)?.emitMessage({
                type: "git_push_rejected",
                reason: "non_fast_forward",
                message: "Branch has diverged from remote. Rebase needed to update.",
              });
            } catch (emitErr) {
              console.error(`[auto-push] ${sessionId}: could not emit git_push_rejected:`, emitErr);
            }
          } else {
            console.warn(
              `[auto-push] ${sessionId}: withholding the rebase banner — its force-push could`
              + " discard commits that exist only on the remote, or the shape could not be measured.",
            );
          }
          const runner = deps.getRunner(sessionId);
          try {
            emitNoticePostTurn(
              // Emission precedes persistence; contain transport errors so the row still lands.
              (m) => {
                try {
                  runner?.emitMessage(m);
                } catch (emitErr) {
                  console.error(`[auto-push] ${sessionId}: could not emit the diverged-push notice:`, emitErr);
                }
              },
              deps.chatHistory,
              sessionId,
              formatDivergedPushNotice(shape, { forcePushBlocked: forcePushBlocked(sessionId) }),
              "warn",
            );
          } catch (noticeErr) {
            // Retry the notice on the next rejection if persistence failed.
            notifiedDiverged.delete(sessionId);
            console.error(`[auto-push] ${sessionId}: diverged-push notice failed:`, noticeErr);
          }
        }
        return;
      }
      const errMsg = getErrorMessage(err);
      if (isGitAuthError(err)) {
        // Token validation and its listeners can fail; still report the unpushed commit.
        let invalidated = false;
        try {
          invalidated = await deps.githubAuthManager.markTokenInvalid(`auto-push failed: ${errMsg}`);
        } catch (markErr) {
          console.error(`[auto-push] ${sessionId}: could not mark the GitHub token invalid:`, markErr);
        }
        if (invalidated) {
          report(
            sessionId,
            "Auto-push failed: your GitHub token is invalid or expired. Sign in again in Settings → GitHub.",
          );
          return;
        }
        report(sessionId, `Auto-push failed (${failure}). The commit stays in this session's local history.`);
        reportGitText(sessionId, errMsg);
        return;
      }
      if (failure === "lfs") {
        report(
          sessionId,
          "Auto-push rejected: the remote refused the push because its Git LFS objects were not "
          + "uploaded (GH008). The commit stays in this session's local history. Run "
          + "`git lfs push origin HEAD` in the terminal, then push again.",
        );
        reportGitText(sessionId, errMsg);
        return;
      }
      if (errMsg.includes("workflow")) {
        report(
          sessionId,
          "Auto-push failed: your GitHub token needs the `workflow` scope to push changes to GitHub Actions workflow files. Update your token at https://github.com/settings/tokens.",
        );
        return;
      }
      report(sessionId, `Auto-push failed (${failure}). The commit stays in this session's local history.`);
      reportGitText(sessionId, errMsg);
    }
  }
}
