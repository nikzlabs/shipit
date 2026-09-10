// Interrupts may produce neither process exit nor a turn result to trigger the normal commit.
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
import type { GenerateText } from "../non-turn-model.js";

export interface PostInterruptCommitDeps {
  sessionManager: SessionManager;
  chatHistoryManager: ChatHistoryManager;
  prStatusPoller: PrStatusPoller;
  githubAuthManager: GitHubAuthManager;
  credentialStore: CredentialStore;
  generateText: GenerateText;
  createGitManager: (dir: string) => GitManager;
  scheduleAutoPush?: (git: GitManager, sessionId?: string) => void;
}

// Allow pending writes time to finish before committing partial work.
export const INTERRUPT_COMMIT_FALLBACK_DELAY_MS = 2000;

export async function runPostInterruptCommit(args: {
  deps: PostInterruptCommitDeps;
  runner: SessionRunnerInterface;
}): Promise<void> {
  const { deps, runner } = args;
  if (runner.disposed) return;

  const sessionId = runner.sessionId;
  const sessionDir = runner.sessionDir;

  // Arm auto-push after the PR flow's own push, even if that flow throws.
  const pending: { arm: (() => void) | null } = { arm: null };
  try {
    const commitHash = await postTurnCommit(
      {
        createGitManager: deps.createGitManager,
        chatHistoryManager: deps.chatHistoryManager,
        sessionManager: deps.sessionManager,
        scheduleAutoPush: deps.scheduleAutoPush ?? (() => {}),
      },
      {
        sessionDir,
        sessionId,
        emit: (msg) => runner.emitMessage(msg),
        turnSummary: runner.turnSummary || "Interrupted turn",
        deferPushArm: (arm) => { pending.arm = arm; },
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
  } finally {
    const arm = pending.arm;
    pending.arm = null;
    try {
      arm?.();
    } catch (armErr) {
      console.error("[interrupt-commit] arming the auto-push failed:", getErrorMessage(armErr));
    }
  }
}

export function scheduleInterruptCommit(args: {
  deps: PostInterruptCommitDeps;
  runner: SessionRunnerInterface;
}): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    void runPostInterruptCommit(args);
  }, INTERRUPT_COMMIT_FALLBACK_DELAY_MS);
}
