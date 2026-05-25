/**
 * Post-interrupt commit fallback (docs/021 follow-up).
 *
 * The normal post-turn commit/PR flow in `agent-execution.ts` runs from either
 *   - the non-streaming `done` handler (process exit), or
 *   - the streaming `agent_result` handler (turn boundary).
 *
 * Neither is guaranteed when the user interrupts:
 *   - Streaming `interrupt()` sends a `control_request` on stdin. The CLI
 *     stays alive and may not emit `agent_result` for an aborted turn — so
 *     `done` never fires and nothing commits.
 *   - The recovery `killAgent` path manually clears `runner.running` after
 *     SIGTERM precisely because it can't trust the `agent_done` SSE event to
 *     arrive — same gap on the commit side.
 *
 * This helper runs the same commit + PR lifecycle as the post-turn flow,
 * triggered from the interrupt/kill paths. Idempotent: `autoCommit` returns
 * null on a clean tree, and `emitPrLifecycleAfterCommit` no-ops when
 * `commitHash` is null, so racing with the normal post-turn flow is safe.
 */

import type { GitManager } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { ChatHistoryManager } from "../chat-history.js";
import type { CredentialStore } from "../credential-store.js";
import type { SessionManager } from "../sessions.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import { postTurnCommit } from "../ws-handlers/post-turn.js";
import { emitPrLifecycleAfterCommit } from "./pr-lifecycle.js";
import { getErrorMessage } from "../validation.js";

/**
 * Deps for the commit fallback. The shape mirrors `PrLifecycleDeps` plus the
 * git manager and chat-history manager `postTurnCommit` needs, and an
 * optional `scheduleAutoPush` (omitted from the recovery path — recovery is
 * commit-only; the user will reattach and a normal turn will push later).
 */
export interface PostInterruptCommitDeps {
  sessionManager: SessionManager;
  chatHistoryManager: ChatHistoryManager;
  prStatusPoller: PrStatusPoller;
  githubAuthManager: GitHubAuthManager;
  credentialStore: CredentialStore;
  generateText: (prompt: string, cwd: string) => Promise<string>;
  createGitManager: (dir: string) => GitManager;
  scheduleAutoPush?: (git: GitManager, sessionId?: string) => void;
}

/**
 * Delay before the interrupt-time commit fires. Long enough that the agent
 * process has had time to flush any in-flight writes (so the partial work
 * lands in one commit, not split across this fallback and the normal
 * post-turn handler), short enough that the user sees the commit promptly.
 */
export const INTERRUPT_COMMIT_FALLBACK_DELAY_MS = 2000;

/**
 * Commit any partial work after an interrupt/kill and emit a PR lifecycle
 * update. Safe to call multiple times — idempotent at the git layer.
 */
export async function runPostInterruptCommit(args: {
  deps: PostInterruptCommitDeps;
  runner: SessionRunnerInterface;
}): Promise<void> {
  const { deps, runner } = args;
  if (runner.disposed) return;

  const sessionId = runner.sessionId;
  const sessionDir = runner.sessionDir;

  try {
    const commitHash = await postTurnCommit(
      {
        createGitManager: deps.createGitManager,
        chatHistoryManager: deps.chatHistoryManager,
        scheduleAutoPush: deps.scheduleAutoPush ?? (() => {}),
      },
      {
        sessionDir,
        sessionId,
        emit: (msg) => runner.emitMessage(msg),
        turnSummary: runner.turnSummary || "Interrupted turn",
      },
    );
    if (!commitHash || runner.disposed) return;

    await emitPrLifecycleAfterCommit({
      deps: {
        sessionManager: deps.sessionManager,
        prStatusPoller: deps.prStatusPoller,
        githubAuthManager: deps.githubAuthManager,
        credentialStore: deps.credentialStore,
        chatHistoryManager: deps.chatHistoryManager,
        generateText: deps.generateText,
        createGitManager: deps.createGitManager,
      },
      sessionId,
      sessionDir,
      commitHash,
      emit: (msg) => runner.emitMessage(msg),
    });
  } catch (err) {
    console.error("[interrupt-commit] failed:", getErrorMessage(err));
  }
}

/**
 * Fire-and-forget wrapper that defers the commit by
 * `INTERRUPT_COMMIT_FALLBACK_DELAY_MS`, then runs `runPostInterruptCommit`.
 * Returns the timer handle so callers (mostly tests) can cancel if needed.
 */
export function scheduleInterruptCommit(args: {
  deps: PostInterruptCommitDeps;
  runner: SessionRunnerInterface;
}): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    void runPostInterruptCommit(args);
  }, INTERRUPT_COMMIT_FALLBACK_DELAY_MS);
}
