import type { WsClientMessage } from "../../shared/types.js";
import type { ConnectionCtx, AppCtx } from "./types.js";
import { getErrorMessage } from "../validation.js";

type WsForkThread = Extract<WsClientMessage, { type: "fork_thread" }>;
type WsSwitchThread = Extract<WsClientMessage, { type: "switch_thread" }>;

export async function handleForkThread(ctx: ConnectionCtx & AppCtx, msg: WsForkThread): Promise<void> {
  const activeAppSessionId = ctx.getActiveAppSessionId();
  if (!activeAppSessionId) {
    ctx.send({ type: "error", message: "No active session" });
    return;
  }
  const checkpointId = typeof msg.checkpointId === "string" ? msg.checkpointId.trim() : "";
  if (!checkpointId) {
    ctx.send({ type: "error", message: "Checkpoint ID is required" });
    return;
  }

  const checkpoint = ctx.threadManager.getCheckpoint(activeAppSessionId, checkpointId);
  if (!checkpoint) {
    ctx.send({ type: "error", message: "Checkpoint not found" });
    return;
  }

  try {
    // Snapshot data BEFORE git rollback. `git reset --hard` reverts all
    // files in the working tree, including thread and chat-history JSON
    // files that live inside the workspace.
    const fullHistory = ctx.chatHistoryManager.load(activeAppSessionId);
    const threadMessages = fullHistory.slice(0, checkpoint.messageIndex);
    const threadSnapshot = ctx.threadManager.listThreads(activeAppSessionId);

    // Roll back git to the checkpoint's commit
    const git = ctx.getActiveGitManager();
    if (checkpoint.commitHash) {
      await git.rollback(checkpoint.commitHash);
    }

    // Restore thread data (may have been reverted by git rollback) and
    // fork the new thread. We call restore to re-persist the snapshot,
    // then forkThread to add the new thread.
    ctx.threadManager.restore(activeAppSessionId, threadSnapshot);
    const newThread = ctx.threadManager.forkThread(activeAppSessionId, checkpointId);
    if (!newThread) {
      ctx.send({ type: "error", message: "Failed to fork thread" });
      return;
    }

    // Build conversation replay for the new thread. When the first
    // message is sent on this fork, the replay is injected as a system
    // prompt so Claude has full context without --resume's hidden history.
    if (threadMessages.length > 0) {
      const replayLines: string[] = [
        "You are continuing a conversation. Here is the conversation so far:\n",
      ];
      for (const m of threadMessages) {
        const label = m.role === "user" ? "User" : "Assistant";
        replayLines.push(`${label}: ${m.text}`);
      }
      replayLines.push("\nContinue from here. The user's next message follows.");
      ctx.threadManager.setConversationReplay(
        activeAppSessionId,
        newThread.id,
        replayLines.join("\n"),
      );
    }

    // Save thread-specific chat history
    const threadHistoryKey = `${activeAppSessionId}__${newThread.id}`;
    for (const m of threadMessages) {
      ctx.chatHistoryManager.append(threadHistoryKey, m);
    }

    ctx.send({
      type: "thread_forked",
      thread: newThread,
      messages: threadMessages,
    });
  } catch (err) {
    ctx.send({ type: "error", message: `Failed to fork thread from checkpoint: ${getErrorMessage(err)}` });
  }
}

export async function handleSwitchThread(ctx: ConnectionCtx & AppCtx, msg: WsSwitchThread): Promise<void> {
  const activeAppSessionId = ctx.getActiveAppSessionId();
  if (!activeAppSessionId) {
    ctx.send({ type: "error", message: "No active session" });
    return;
  }
  const threadId = typeof msg.threadId === "string" ? msg.threadId.trim() : "";
  if (!threadId) {
    ctx.send({ type: "error", message: "Thread ID is required" });
    return;
  }

  // Snapshot thread data before switch (git rollback may revert files)
  const threadSnapshot = ctx.threadManager.listThreads(activeAppSessionId);

  const thread = ctx.threadManager.switchThread(activeAppSessionId, threadId);
  if (!thread) {
    ctx.send({ type: "error", message: "Thread not found" });
    return;
  }

  try {
    // Load conversation for this thread BEFORE any git rollback
    let messages;
    if (thread.parentCheckpointId === null) {
      messages = ctx.chatHistoryManager.load(activeAppSessionId);
    } else {
      const threadHistoryKey = `${activeAppSessionId}__${threadId}`;
      messages = ctx.chatHistoryManager.load(threadHistoryKey);
    }

    // Roll back git to the thread's parent checkpoint
    if (thread.parentCheckpointId) {
      const checkpoint = ctx.threadManager.getCheckpoint(activeAppSessionId, thread.parentCheckpointId);
      if (checkpoint?.commitHash) {
        const git = ctx.getActiveGitManager();
        await git.rollback(checkpoint.commitHash);
        // Restore thread data after rollback (git reset may have reverted it)
        ctx.threadManager.restore(activeAppSessionId, {
          ...threadSnapshot,
          activeThreadId: threadId,
          threads: threadSnapshot.threads.map((t) => ({
            ...t,
            isActive: t.id === threadId,
          })),
        });
      }
    }

    ctx.send({
      type: "thread_switched",
      thread,
      messages,
    });
  } catch (err) {
    ctx.send({ type: "error", message: `Failed to switch thread: ${getErrorMessage(err)}` });
  }
}
