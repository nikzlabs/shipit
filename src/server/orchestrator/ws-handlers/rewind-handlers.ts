import path from "node:path";
import fs from "node:fs/promises";
import type { WsClientMessage } from "../../shared/types.js";
import type { ConnectionCtx, AppCtx, RunnerCtx } from "./types.js";
import { getErrorMessage } from "../validation.js";
import { buildConversationReplay } from "../services/replay.js";
import type { PersistedMessage } from "../chat-history.js";
import { resolveRunner } from "./resolve-runner.js";

type WsRewindToMessage = Extract<WsClientMessage, { type: "rewind_to_message" }>;

/**
 * Find the commit hash representing the code state just before a given
 * message index. Walks backwards through chat history looking for the
 * latest assistant message with a commitHash before the target index.
 * Returns null if no commits exist before that point.
 */
function findCommitBeforeMessage(
  messages: { commitHash?: string }[],
  messageIndex: number,
): string | null {
  for (let i = messageIndex - 1; i >= 0; i--) {
    if (messages[i].commitHash) {
      return messages[i].commitHash!;
    }
  }
  return null;
}

/**
 * Delete uploaded files referenced by the given messages.
 * Silently ignores files that no longer exist.
 */
async function deleteUploadsFromMessages(messages: PersistedMessage[], uploadsDir: string): Promise<void> {
  const uploadPaths = new Set<string>();
  for (const msg of messages) {
    if (msg.files) {
      for (const f of msg.files) {
        if (f.path.startsWith("/uploads/")) {
          uploadPaths.add(f.path);
        }
      }
    }
  }
  await Promise.all(
    [...uploadPaths].map((p) => {
      const filename = path.basename(p);
      return fs.unlink(path.join(uploadsDir, filename)).catch(() => {});
    }),
  );
}

/**
 * Rewind to a user message. Three modes:
 * - fork_chat: truncate chat + reset agent, code unchanged
 * - rewind_code: git reset to before this message, keep chat
 * - rewind_all: git reset + truncate chat + reset agent
 */
export async function handleRewindToMessage(ctx: ConnectionCtx & RunnerCtx & AppCtx, msg: WsRewindToMessage): Promise<void> {
  const sessionId = ctx.getActiveAppSessionId();
  if (!sessionId) {
    ctx.send({ type: "error", message: "No active session" });
    return;
  }
  const runner = resolveRunner(ctx, sessionId);
  if (runner?.running) {
    ctx.send({ type: "error", message: "Cannot rewind while a turn is running." });
    return;
  }

  const { messageIndex, mode } = msg;
  if (typeof messageIndex !== "number") {
    ctx.send({ type: "error", message: "Invalid rewind parameters" });
    return;
  }

  const allMessages = ctx.chatHistoryManager.load(sessionId);

  // For modes that affect code, find the commit to rollback to
  const needsGitRollback = mode === "rewind_code" || mode === "rewind_all";
  let rollbackHash: string | null = null;

  if (needsGitRollback) {
    // Check if any commits exist after this message that need reverting
    const hasCommitsAfter = allMessages.slice(messageIndex).some((m) => m.commitHash);
    if (hasCommitsAfter) {
      rollbackHash = findCommitBeforeMessage(allMessages, messageIndex);
      // If no commit exists before this message, rollback to the initial commit
      // by using the parentCommitHash of the first committed assistant message
      if (!rollbackHash) {
        for (let i = messageIndex; i < allMessages.length; i++) {
          if (allMessages[i].parentCommitHash) {
            rollbackHash = allMessages[i].parentCommitHash!;
            break;
          }
        }
      }
    }
  }

  try {
    const queuedCount = runner?.messageQueue.length ?? 0;
    if (queuedCount > 0 && runner) {
      runner.clearQueue();
      runner.emitMessage({
        type: "system_notice",
        sessionId,
        message: `Cleared ${queuedCount} queued message${queuedCount === 1 ? "" : "s"} as part of rewind.`,
        level: "info",
      });
    }
    switch (mode) {
      case "fork_chat": {
        // Truncate chat + reset agent, no git changes
        const truncated = allMessages.slice(0, messageIndex);
        const removed = allMessages.slice(messageIndex);
        const uploadsDir = path.join(path.dirname(ctx.getActiveDir()), "uploads");
        await deleteUploadsFromMessages(removed, uploadsDir);
        ctx.chatHistoryManager.saveMessages(sessionId, truncated);
        const replay = buildConversationReplay(truncated);
        if (replay) {
          ctx.sessionManager.setConversationReplay(sessionId, replay);
        }
        ctx.sessionManager.clearAgentSessionId(sessionId);
        ctx.send({ type: "rewind_complete", messageIndex });
        break;
      }

      case "rewind_code": {
        // Git reset only, chat stays
        if (!rollbackHash) {
          ctx.send({ type: "error", message: "No code changes to rewind" });
          break;
        }
        const git = ctx.getActiveGitManager();
        await git.rollback(rollbackHash);
        ctx.chatHistoryManager.markRolledBackFromIndex(sessionId, messageIndex, rollbackHash);
        const replay = buildConversationReplay(allMessages);
        if (replay) {
          ctx.sessionManager.setConversationReplay(sessionId, replay);
        }
        ctx.sessionManager.clearAgentSessionId(sessionId);
        ctx.send({ type: "rollback_complete", messageIndex, mode: "code", parentCommitHash: rollbackHash });
        break;
      }

      case "rewind_all": {
        // Git reset + truncate chat + reset agent
        if (rollbackHash) {
          const git = ctx.getActiveGitManager();
          await git.rollback(rollbackHash);
        }
        const truncated = allMessages.slice(0, messageIndex);
        const removed = allMessages.slice(messageIndex);
        const uploadsDir = path.join(path.dirname(ctx.getActiveDir()), "uploads");
        await deleteUploadsFromMessages(removed, uploadsDir);
        ctx.chatHistoryManager.saveMessages(sessionId, truncated);
        const replay = buildConversationReplay(truncated);
        if (replay) {
          ctx.sessionManager.setConversationReplay(sessionId, replay);
        }
        ctx.sessionManager.clearAgentSessionId(sessionId);
        ctx.send({ type: "rewind_complete", messageIndex });
        break;
      }
    }
  } catch (err) {
    ctx.send({ type: "error", message: `Rewind failed: ${getErrorMessage(err)}` });
  }
}
