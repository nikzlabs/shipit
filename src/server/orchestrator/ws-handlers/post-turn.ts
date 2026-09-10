import type { WsServerMessage } from "../../shared/types.js";
import type { ConnectionCtx, AppCtx } from "./types.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import { withWorkspaceLock } from "../services/marketplace.js";
import { formatUnresolvedConflictNotice } from "../services/conflict-marker-notice.js";
import { recordSecretBlock, clearSecretBlock } from "../services/secret-block.js";
import { evaluateMergedBranchPush, formatMergedPushNotice } from "../services/merged-push-guard.js";
import { scanDiffForSecrets } from "../../shared/secret-scan.js";
import { emitNoticePostTurn } from "../chat-card-persistence.js";
import {
  formatUnreadableWorkspaceNotice,
  formatUncommittedTurnNotice,
} from "../services/unreadable-workspace-notice.js";
import { sessionAutoCommitAllowed } from "../services/auto-commit-gate.js";
import { chownWorkspaceGitToSessionWorker } from "../session-worker-uid.js";

type PostTurnCtx = Pick<ConnectionCtx & AppCtx, "createGitManager" | "chatHistoryManager" | "sessionManager"> & {
  scheduleAutoPush: (git: ReturnType<AppCtx["createGitManager"]>, sessionId?: string) => void;
};

export async function postTurnCommit(
  ctx: PostTurnCtx,
  opts: {
    sessionDir: string;
    sessionId: string | undefined;
    emit: (msg: WsServerMessage) => void;
    turnSummary: string;
    turnStartHeadHash?: string | null;
    runner?: SessionRunnerInterface | null;
    /** Defer arming until after PR pushes, but decide before that flow clears mergedAt. */
    deferPushArm?: (arm: () => void) => void;
  },
): Promise<string | null> {
  if (!sessionAutoCommitAllowed(ctx.sessionManager, opts.sessionId)) {
    return null;
  }
  // Share the install lock: path-scoped staging must not race git add -A.
  return withWorkspaceLock(opts.sessionDir, async () => {
    // Repair before git drops to the tree owner; post-commit repair would be too late.
    chownWorkspaceGitToSessionWorker(opts.sessionDir);
    try {
      return await commitInLock();
    } finally {
      chownWorkspaceGitToSessionWorker(opts.sessionDir);
    }
  });

  async function pushUnlessMerged(
    git: ReturnType<AppCtx["createGitManager"]>,
    commitHash: string | null,
  ): Promise<void> {
    const sessionId = opts.sessionId;
    const block = sessionId
      ? await evaluateMergedBranchPush(
          ctx.sessionManager.get(sessionId),
          () => ctx.sessionManager.getPrStatus(sessionId),
          git,
        )
      : null;
    if (!block || !sessionId) {
      const arm = (): void => ctx.scheduleAutoPush(git, opts.sessionId);
      if (opts.deferPushArm) opts.deferPushArm(arm);
      else arm();
      return;
    }
    console.warn(
      `[merged-push-guard] auto-push refused for ${sessionId}: pull request `
        + `${block.prNumber ? `#${block.prNumber}` : "(unknown)"} already merged and this commit `
        + `${commitHash ? `(${commitHash.slice(0, 7)}) ` : ""}is stacked on the merged tip.`,
    );
    try {
      emitNoticePostTurn(
        opts.emit,
        ctx.chatHistoryManager,
        sessionId,
        formatMergedPushNotice(block, commitHash),
        "warn",
      );
    } catch (err) {
      console.error(`[merged-push-guard] notice failed for ${sessionId}:`, err);
    }
  }

  async function autoCommitReportingFailure(
    git: ReturnType<AppCtx["createGitManager"]>,
    summary: string,
  ): Promise<Awaited<ReturnType<typeof git.autoCommit>>> {
    try {
      return await git.autoCommit(summary);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[git] auto-commit failed for ${opts.sessionId ?? "(no session)"}:`, reason);
      if (opts.sessionId) {
        try {
          emitNoticePostTurn(
            opts.emit,
            ctx.chatHistoryManager,
            opts.sessionId,
            formatUncommittedTurnNotice(reason),
            "warn",
          );
        } catch (noticeErr) {
          console.error(`[git] uncommitted-turn notice failed for ${opts.sessionId}:`, noticeErr);
        }
      }
      throw err;
    }
  }

  async function commitInLock(): Promise<string | null> {
    const git = ctx.createGitManager(opts.sessionDir);
    const parentHash = await git.getHeadHash();
    const firstLine = opts.turnSummary.split("\n")[0]?.slice(0, 120) || "Agent turn";
    const { commitHash, conflictedFiles, rebaseInProgress, secretFindings, unreadable } =
      await autoCommitReportingFailure(git, firstLine);
    if (unreadable && opts.sessionId) {
      emitNoticePostTurn(
        opts.emit,
        ctx.chatHistoryManager,
        opts.sessionId,
        formatUnreadableWorkspaceNotice(unreadable, { committed: commitHash !== null }),
        "warn",
      );
    }
    if (secretFindings.length > 0 && opts.sessionId) {
      recordSecretBlock(
        {
          sessionId: opts.sessionId,
          sessionManager: ctx.sessionManager,
          chatHistory: ctx.chatHistoryManager,
          emit: opts.emit,
          runner: opts.runner,
        },
        secretFindings,
      );
    }
    // These early returns skip scanning; they cannot clear an existing secret block.
    if (
      opts.sessionId
      && secretFindings.length === 0
      && conflictedFiles.length === 0
      && !rebaseInProgress
      && unreadable?.kind !== "blocked"
    ) {
      clearSecretBlock({
        sessionId: opts.sessionId,
        sessionManager: ctx.sessionManager,
        emit: opts.emit,
      });
    }
    if ((conflictedFiles.length > 0 || rebaseInProgress) && opts.sessionId) {
      emitNoticePostTurn(
        opts.emit,
        ctx.chatHistoryManager,
        opts.sessionId,
        formatUnresolvedConflictNotice({ conflictedFiles, rebaseInProgress }),
        "warn",
      );
    }
    if (!commitHash) {
      const currentHeadHash = await git.getHeadHash();
      if (
        opts.turnStartHeadHash &&
        currentHeadHash &&
        currentHeadHash !== opts.turnStartHeadHash
      ) {
        // Scan agent-made additions; rewritten history is excluded to avoid flagging replayed commits.
        const addedOnTop = await git.isAncestor(opts.turnStartHeadHash, currentHeadHash);
        if (addedOnTop) {
          const findings = scanDiffForSecrets(
            await git.diffRange(opts.turnStartHeadHash, currentHeadHash),
          );
          if (findings.length > 0) {
            if (opts.sessionId) {
              recordSecretBlock(
                {
                  sessionId: opts.sessionId,
                  sessionManager: ctx.sessionManager,
                  chatHistory: ctx.chatHistoryManager,
                  emit: opts.emit,
                  runner: opts.runner,
                },
                findings,
              );
            }
            return null;
          }
        }
        await pushUnlessMerged(git, currentHeadHash);
      }
      return null;
    }

    opts.emit({ type: "git_committed", hash: commitHash, message: firstLine });
    await pushUnlessMerged(git, commitHash);

    if (opts.sessionId && parentHash) {
      // The result handler retries this link if final history rows do not exist yet.
      if (opts.runner) {
        opts.runner.pendingCommitLink = { commitHash, parentCommitHash: parentHash };
      }
      const updatedId = ctx.chatHistoryManager.updateLastMessage(opts.sessionId, {
        commitHash,
        parentCommitHash: parentHash,
      });
      if (updatedId !== null) {
        if (opts.runner) opts.runner.pendingCommitLink = null;
        const messageIndex = ctx.chatHistoryManager.indexOfMessageId(opts.sessionId, updatedId);
        if (messageIndex >= 0) {
          opts.emit({
            type: "commit_linked",
            messageIndex,
            commitHash,
            parentCommitHash: parentHash,
          });
        }
      }
    }
    return commitHash;
  }
}
