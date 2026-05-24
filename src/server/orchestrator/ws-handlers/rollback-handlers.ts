import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import type { WsClientMessage } from "../../shared/types.js";
import type { ConnectionCtx, AppCtx, RunnerCtx } from "./types.js";
import { getErrorMessage } from "../validation.js";
import { buildConversationReplay } from "../services/replay.js";
import { archiveSession, forkSession } from "../services/session.js";
import type { PersistedMessage, RewindSnapshotInfo } from "../chat-history.js";
import { resolveRunner } from "./resolve-runner.js";

type WsRollbackCode = Extract<WsClientMessage, { type: "rollback_code" }>;
type WsRollbackCodeAndChat = Extract<WsClientMessage, { type: "rollback_code_and_chat" }>;
type WsForkSessionFromMessage = Extract<WsClientMessage, { type: "fork_session_from_message" }>;
type WsRewindAtGap = Extract<WsClientMessage, { type: "rewind_at_gap" }>;
type WsRewindPreviewRequest = Extract<WsClientMessage, { type: "rewind_preview_request" }>;
type WsRewindRestoreRequest = Extract<WsClientMessage, { type: "rewind_restore_request" }>;

type RewindCtx = ConnectionCtx & RunnerCtx & AppCtx;

function findCommitBeforeGap(messages: PersistedMessage[], gapPosition: number): string | null {
  for (let i = gapPosition - 1; i >= 0; i--) {
    const commitHash = messages[i].commitHash;
    if (commitHash) return commitHash;
  }
  for (let i = gapPosition; i < messages.length; i++) {
    const parentCommitHash = messages[i].parentCommitHash;
    if (parentCommitHash) return parentCommitHash;
  }
  return null;
}

function countTurnGroups(messages: PersistedMessage[]): number {
  let count = 0;
  let lastRole: PersistedMessage["role"] | null = null;
  for (const message of messages) {
    if (message.notice) continue;
    if (message.role !== lastRole) {
      count += 1;
      lastRole = message.role;
    }
  }
  return count;
}

function collectUploadPaths(messages: PersistedMessage[]): string[] {
  const paths = new Set<string>();
  for (const msg of messages) {
    for (const file of msg.files ?? []) {
      if (file.path.startsWith("/uploads/")) paths.add(file.path);
    }
    for (const uploadPath of msg.uploadPaths ?? []) {
      if (uploadPath.startsWith("/uploads/")) paths.add(uploadPath);
    }
  }
  return [...paths];
}

async function deleteUploadsFromMessages(messages: PersistedMessage[], uploadsDir: string): Promise<void> {
  await Promise.all(collectUploadPaths(messages).map((p) => fs.unlink(path.join(uploadsDir, path.basename(p))).catch(() => {})));
}

async function copyUploadsForFork(messages: PersistedMessage[], sourceUploadsDir: string, targetUploadsDir: string): Promise<void> {
  await fs.mkdir(targetUploadsDir, { recursive: true });
  await Promise.all(collectUploadPaths(messages).map((p) => {
    const filename = path.basename(p);
    return fs.copyFile(path.join(sourceUploadsDir, filename), path.join(targetUploadsDir, filename)).catch(() => {});
  }));
}

function clearQueuedMessages(ctx: RewindCtx, sessionId: string): void {
  const runner = resolveRunner(ctx, sessionId);
  const queuedCount = runner?.messageQueue.length ?? 0;
  if (queuedCount === 0 || !runner) return;
  runner.clearQueue();
  runner.emitMessage({
    type: "system_notice",
    sessionId,
    message: `Cleared ${queuedCount} queued message${queuedCount === 1 ? "" : "s"} as part of rewind.`,
    level: "info",
  });
}

function emitSnapshotAvailable(ctx: RewindCtx, snapshot: RewindSnapshotInfo): void {
  const message = {
    type: "rewind_snapshot_available" as const,
    sessionId: snapshot.sessionId,
    action: snapshot.action,
    expiresAt: snapshot.expiresAt,
  };
  ctx.getRunnerRegistry().get(snapshot.sessionId)?.emitMessage(message);
  ctx.send(message);
}

export async function handleRewindPreviewRequest(ctx: RewindCtx, msg: WsRewindPreviewRequest): Promise<void> {
  const sessionId = ctx.getActiveAppSessionId();
  if (!sessionId) {
    ctx.send({ type: "error", message: "No active session" });
    return;
  }

  const { action, gapPosition } = msg;
  if (!Number.isInteger(gapPosition) || gapPosition < 0 || !["chat", "code", "both", "fork"].includes(action)) {
    ctx.send({ type: "error", message: "Invalid rewind preview parameters" });
    return;
  }

  const allMessages = ctx.chatHistoryManager.load(sessionId);
  if (gapPosition > allMessages.length) {
    ctx.send({ type: "error", message: "Invalid rewind position" });
    return;
  }

  const response = {
    type: "rewind_preview" as const,
    gapPosition,
    action,
  };

  if (action === "fork") {
    ctx.send({
      ...response,
      keptTurnGroupCount: countTurnGroups(allMessages.slice(0, gapPosition)),
    });
    return;
  }

  const rollbackHash = findCommitBeforeGap(allMessages, gapPosition);
  const headHash = await ctx.getActiveGitManager().getHeadHash();
  const fileCount = rollbackHash && headHash
    ? (await ctx.getActiveGitManager().diffNameStatus(rollbackHash, headHash)).length
    : 0;

  ctx.send({
    ...response,
    discardedTurnGroupCount: countTurnGroups(allMessages.slice(gapPosition)),
    ...(action === "code" || action === "both" ? { fileCount } : {}),
  });
}

export async function handleRewindAtGap(ctx: RewindCtx, msg: WsRewindAtGap): Promise<void> {
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

  const { action, gapPosition } = msg;
  if (!Number.isInteger(gapPosition) || gapPosition < 0 || !["chat", "code", "both", "fork"].includes(action)) {
    ctx.send({ type: "error", message: "Invalid rewind parameters" });
    return;
  }

  const sessionDir = ctx.getActiveSessionDir();
  const allMessages = ctx.chatHistoryManager.load(sessionId);
  if (gapPosition > allMessages.length) {
    ctx.send({ type: "error", message: "Invalid rewind position" });
    return;
  }
  if (action !== "fork" && gapPosition === allMessages.length) {
    ctx.send({ type: "error", message: "Nothing to rewind from the current state." });
    return;
  }

  try {
    clearQueuedMessages(ctx, sessionId);

    if (action === "chat") {
      const truncated = allMessages.slice(0, gapPosition);
      const removed = allMessages.slice(gapPosition);
      const snapshot = ctx.chatHistoryManager.createRewindSnapshot(sessionId, { action: "chat", messages: allMessages });
      if (sessionDir) await deleteUploadsFromMessages(removed, path.join(path.dirname(sessionDir), "uploads"));
      ctx.chatHistoryManager.saveMessages(sessionId, truncated);
      const replay = buildConversationReplay(truncated);
      if (replay) ctx.sessionManager.setConversationReplay(sessionId, replay);
      ctx.sessionManager.clearAgentSessionId(sessionId);
      ctx.send({
        type: "rewind_complete",
        gapPosition,
        action: "chat",
        droppedMessageCount: removed.length,
        snapshotSessionId: snapshot.sessionId,
        snapshotExpiresAt: snapshot.expiresAt,
      });
      emitSnapshotAvailable(ctx, snapshot);
      return;
    }

    const rollbackHash = action === "fork"
      ? gapPosition === allMessages.length
        ? await ctx.getActiveGitManager().getHeadHash()
        : findCommitBeforeGap(allMessages, gapPosition)
      : findCommitBeforeGap(allMessages, gapPosition);

    if (!rollbackHash) {
      ctx.send({ type: "error", message: action === "fork" ? "No code state available to fork." : "No code changes to rewind from this point." });
      return;
    }

    if (action === "code") {
      const hasCommitsAfter = allMessages.slice(gapPosition).some((m) => m.commitHash);
      if (!hasCommitsAfter) {
        ctx.send({ type: "error", message: "No code changes to rewind from this point." });
        return;
      }
      const headHash = await ctx.getActiveGitManager().getHeadHash();
      if (!headHash) {
        ctx.send({ type: "error", message: "No current code state available to restore." });
        return;
      }
      await ctx.getActiveGitManager().rollback(rollbackHash);
      const flippedMessageIds = ctx.chatHistoryManager.markRolledBackFromIndex(sessionId, gapPosition, rollbackHash);
      const snapshot = ctx.chatHistoryManager.createRewindSnapshot(sessionId, { action: "code", headHash, flippedMessageIds });
      const replay = buildConversationReplay(allMessages);
      if (replay) ctx.sessionManager.setConversationReplay(sessionId, replay);
      ctx.sessionManager.clearAgentSessionId(sessionId);
      ctx.send({
        type: "rewind_complete",
        gapPosition,
        action: "code",
        commitHash: rollbackHash,
        snapshotSessionId: snapshot.sessionId,
        snapshotExpiresAt: snapshot.expiresAt,
      });
      emitSnapshotAvailable(ctx, snapshot);
      return;
    }

    if (action === "both") {
      const headHash = await ctx.getActiveGitManager().getHeadHash();
      if (!headHash) {
        ctx.send({ type: "error", message: "No current code state available to restore." });
        return;
      }
      const snapshot = ctx.chatHistoryManager.createRewindSnapshot(sessionId, { action: "both", messages: allMessages, headHash });
      await ctx.getActiveGitManager().rollback(rollbackHash);
      const truncated = allMessages.slice(0, gapPosition);
      const removed = allMessages.slice(gapPosition);
      if (sessionDir) await deleteUploadsFromMessages(removed, path.join(path.dirname(sessionDir), "uploads"));
      ctx.chatHistoryManager.saveMessages(sessionId, truncated);
      ctx.chatHistoryManager.append(sessionId, {
        role: "assistant",
        text: `Code rolled back to ${rollbackHash.slice(0, 7)}. The changes from the previous response have been reverted.`,
        notice: true,
        noticeLevel: "info",
      });
      const replay = buildConversationReplay(truncated);
      if (replay) ctx.sessionManager.setConversationReplay(sessionId, replay);
      ctx.sessionManager.clearAgentSessionId(sessionId);
      ctx.send({
        type: "rewind_complete",
        gapPosition,
        action: "both",
        droppedMessageCount: removed.length,
        commitHash: rollbackHash,
        snapshotSessionId: snapshot.sessionId,
        snapshotExpiresAt: snapshot.expiresAt,
      });
      emitSnapshotAvailable(ctx, snapshot);
      return;
    }

    if (!sessionDir) {
      ctx.send({ type: "error", message: "No active session directory" });
      return;
    }
    const branchName = (msg.branchName?.trim() || `fork-${crypto.randomUUID().slice(0, 8)}`).slice(0, 80);
    const result = await forkSession(
      ctx.sessionManager,
      ctx.createRepoGit,
      ctx.getSharedRepoDir,
      ctx.sessionsRoot,
      ctx.githubAuthManager,
      { init: () => {} },
      sessionId,
      sessionDir,
      branchName,
      rollbackHash,
    );
    const truncatedMessages = allMessages.slice(0, gapPosition);
    ctx.chatHistoryManager.saveMessages(result.session.id, truncatedMessages);
    await copyUploadsForFork(truncatedMessages, path.join(path.dirname(sessionDir), "uploads"), path.join(ctx.sessionsRoot, result.session.id, "uploads"));
    const replay = buildConversationReplay(truncatedMessages);
    if (replay) ctx.sessionManager.setConversationReplay(result.session.id, replay);

    const breadcrumb: PersistedMessage = {
      role: "assistant",
      text: "",
      forkChild: { childSessionId: result.session.id, title: result.session.title, branch: branchName },
    };
    const breadcrumbMessageId = ctx.chatHistoryManager.append(sessionId, breadcrumb);
    const snapshot = ctx.chatHistoryManager.createRewindSnapshot(sessionId, {
      action: "fork",
      childSessionId: result.session.id,
      breadcrumbMessageId,
    });
    ctx.getRunnerRegistry().get(sessionId)?.emitMessage({ type: "fork_breadcrumb", parentSessionId: sessionId, message: breadcrumb });
    ctx.sseBroadcast("session_list", { sessions: result.sessions });
    ctx.send({
      type: "session_forked",
      parentSessionId: sessionId,
      childSessionId: result.session.id,
      title: result.session.title,
      branch: branchName,
      snapshotSessionId: snapshot.sessionId,
      snapshotExpiresAt: snapshot.expiresAt,
      sessionId: result.session.id,
      sessionName: result.session.title,
    });
    emitSnapshotAvailable(ctx, snapshot);
  } catch (err) {
    ctx.send({ type: "error", message: `Rewind failed: ${getErrorMessage(err)}` });
  }
}

export async function handleRewindRestoreRequest(ctx: RewindCtx, msg: WsRewindRestoreRequest): Promise<void> {
  const targetSessionId = msg.sessionId?.trim();
  if (!targetSessionId) {
    ctx.send({ type: "error", message: "No rewind snapshot selected." });
    return;
  }

  const runner = resolveRunner(ctx, targetSessionId);
  if (runner?.running) {
    ctx.send({ type: "error", message: "Cannot recover rewind while a turn is running." });
    return;
  }

  const snapshot = ctx.chatHistoryManager.consumeRewindSnapshot(targetSessionId);
  if (!snapshot) {
    ctx.send({ type: "error", message: "No recent rewind is available to recover." });
    return;
  }

  try {
    if (snapshot.action === "chat") {
      ctx.chatHistoryManager.saveMessages(targetSessionId, snapshot.messages);
      const replay = buildConversationReplay(snapshot.messages);
      if (replay) ctx.sessionManager.setConversationReplay(targetSessionId, replay);
      ctx.sessionManager.clearAgentSessionId(targetSessionId);
      ctx.send({ type: "rewind_restored", sessionId: targetSessionId, action: "chat" });
      return;
    }

    const targetSession = ctx.sessionManager.get(targetSessionId);
    const git = targetSession?.workspaceDir
      ? ctx.createGitManager(targetSession.workspaceDir)
      : targetSessionId === ctx.getActiveAppSessionId()
        ? ctx.getActiveGitManager()
        : null;

    if (snapshot.action === "code") {
      if (!git) throw new Error("No workspace available for code restore");
      await git.rollback(snapshot.headHash);
      ctx.chatHistoryManager.clearRolledBack(targetSessionId, snapshot.flippedMessageIds);
      ctx.sessionManager.clearAgentSessionId(targetSessionId);
      ctx.send({ type: "rewind_restored", sessionId: targetSessionId, action: "code" });
      return;
    }

    if (snapshot.action === "both") {
      ctx.chatHistoryManager.saveMessages(targetSessionId, snapshot.messages);
      const replay = buildConversationReplay(snapshot.messages);
      if (replay) ctx.sessionManager.setConversationReplay(targetSessionId, replay);
      ctx.sessionManager.clearAgentSessionId(targetSessionId);
      if (!git) throw new Error("No workspace available for code restore");
      await git.rollback(snapshot.headHash);
      ctx.send({ type: "rewind_restored", sessionId: targetSessionId, action: "both" });
      return;
    }

    const result = await archiveSession(
      ctx.sessionManager,
      ctx.getRunnerRegistry(),
      ctx.getSharedRepoDir,
      snapshot.childSessionId,
    );
    ctx.chatHistoryManager.deleteMessageById(targetSessionId, snapshot.breadcrumbMessageId);
    ctx.sseBroadcast("session_list", { sessions: result.sessions });
    ctx.send({
      type: "rewind_restored",
      sessionId: targetSessionId,
      action: "fork",
      archivedSessionId: snapshot.childSessionId,
    });
  } catch (err) {
    ctx.chatHistoryManager.createRewindSnapshot(targetSessionId, snapshot);
    ctx.send({ type: "error", message: `Recover rewind failed: ${getErrorMessage(err)}` });
  }
}

/**
 * Rollback code only — git reset, chat stays as-is.
 * Client injects a visual divider + system note so Claude knows about the rollback.
 */
export async function handleRollbackCode(ctx: RewindCtx, msg: WsRollbackCode): Promise<void> {
  const sessionId = ctx.getActiveAppSessionId();
  if (!sessionId) {
    ctx.send({ type: "error", message: "No active session" });
    return;
  }

  const { parentCommitHash, messageIndex } = msg;
  if (!parentCommitHash || typeof messageIndex !== "number") {
    ctx.send({ type: "error", message: "Invalid rollback parameters" });
    return;
  }

  try {
    const runner = resolveRunner(ctx, sessionId);
    if (runner?.running) {
      ctx.send({ type: "error", message: "Cannot rewind while a turn is running." });
      return;
    }
    clearQueuedMessages(ctx, sessionId);
    const git = ctx.getActiveGitManager();
    await git.rollback(parentCommitHash);
    ctx.chatHistoryManager.markRolledBackFromIndex(sessionId, messageIndex, parentCommitHash);
    const replay = buildConversationReplay(ctx.chatHistoryManager.load(sessionId));
    if (replay) ctx.sessionManager.setConversationReplay(sessionId, replay);
    ctx.sessionManager.clearAgentSessionId(sessionId);
    ctx.send({ type: "rollback_complete", messageIndex, mode: "code", parentCommitHash });
  } catch (err) {
    ctx.send({ type: "error", message: `Rollback failed: ${getErrorMessage(err)}` });
  }
}

/**
 * Rollback code + chat — git reset, old messages become dimmed/read-only,
 * fresh Claude CLI session with conversation replay.
 */
export async function handleRollbackCodeAndChat(ctx: RewindCtx, msg: WsRollbackCodeAndChat): Promise<void> {
  const sessionId = ctx.getActiveAppSessionId();
  if (!sessionId) {
    ctx.send({ type: "error", message: "No active session" });
    return;
  }

  const { parentCommitHash, messageIndex } = msg;
  if (!parentCommitHash || typeof messageIndex !== "number") {
    ctx.send({ type: "error", message: "Invalid rollback parameters" });
    return;
  }

  try {
    const runner = resolveRunner(ctx, sessionId);
    if (runner?.running) {
      ctx.send({ type: "error", message: "Cannot rewind while a turn is running." });
      return;
    }
    clearQueuedMessages(ctx, sessionId);
    const git = ctx.getActiveGitManager();
    await git.rollback(parentCommitHash);

    const allMessages = ctx.chatHistoryManager.load(sessionId);
    const truncatedMessages = allMessages.slice(0, messageIndex);
    ctx.chatHistoryManager.saveMessages(sessionId, truncatedMessages);
    ctx.chatHistoryManager.append(sessionId, {
      role: "assistant",
      text: `Code rolled back to ${parentCommitHash.slice(0, 7)}. The changes from the previous response have been reverted.`,
      notice: true,
      noticeLevel: "info",
    });
    const replay = buildConversationReplay(truncatedMessages);
    if (replay) {
      ctx.sessionManager.setConversationReplay(sessionId, replay);
    }

    // Clear agent session ID so next message starts a fresh CLI session
    ctx.sessionManager.clearAgentSessionId(sessionId);

    ctx.send({ type: "rollback_complete", messageIndex, mode: "code_and_chat", parentCommitHash });
  } catch (err) {
    ctx.send({ type: "error", message: `Rollback failed: ${getErrorMessage(err)}` });
  }
}

/**
 * Fork as new session — create a new session (clone) at the rollback point,
 * with truncated chat history + conversation replay.
 */
export async function handleForkSessionFromMessage(ctx: RewindCtx, msg: WsForkSessionFromMessage): Promise<void> {
  const sessionId = ctx.getActiveAppSessionId();
  if (!sessionId) {
    ctx.send({ type: "error", message: "No active session" });
    return;
  }

  const sessionDir = ctx.getActiveSessionDir();
  if (!sessionDir) {
    ctx.send({ type: "error", message: "No active session directory" });
    return;
  }

  const { parentCommitHash, messageIndex } = msg;
  if (!parentCommitHash || typeof messageIndex !== "number") {
    ctx.send({ type: "error", message: "Invalid fork parameters" });
    return;
  }

  try {
    const runner = resolveRunner(ctx, sessionId);
    if (runner?.running) {
      ctx.send({ type: "error", message: "Cannot rewind while a turn is running." });
      return;
    }
    clearQueuedMessages(ctx, sessionId);
    // Generate a branch name for the fork
    const shortId = crypto.randomUUID().slice(0, 8);
    const branchName = `fork-${shortId}`;

    const result = await forkSession(
      ctx.sessionManager,
      ctx.createRepoGit,
      ctx.getSharedRepoDir,
      ctx.sessionsRoot,
      ctx.githubAuthManager,
      { init: () => {} }, // No thread manager needed
      sessionId,
      sessionDir,
      branchName,
      parentCommitHash,
    );

    // Copy truncated chat history to the new session
    const allMessages = ctx.chatHistoryManager.load(sessionId);
    const truncatedMessages = allMessages.slice(0, messageIndex + 1);
    ctx.chatHistoryManager.saveMessages(result.session.id, truncatedMessages);
    await copyUploadsForFork(truncatedMessages, path.join(path.dirname(sessionDir), "uploads"), path.join(ctx.sessionsRoot, result.session.id, "uploads"));

    // Build + store conversation replay on the new session
    const replay = buildConversationReplay(truncatedMessages);
    if (replay) {
      ctx.sessionManager.setConversationReplay(result.session.id, replay);
    }

    // Broadcast updated session list via SSE
    ctx.sseBroadcast("session_list", { sessions: result.sessions });

    const breadcrumb: PersistedMessage = {
      role: "assistant",
      text: "",
      forkChild: { childSessionId: result.session.id, title: result.session.title, branch: branchName },
    };
    ctx.chatHistoryManager.append(sessionId, breadcrumb);
    ctx.getRunnerRegistry().get(sessionId)?.emitMessage({ type: "fork_breadcrumb", parentSessionId: sessionId, message: breadcrumb });

    ctx.send({
      type: "session_forked",
      parentSessionId: sessionId,
      childSessionId: result.session.id,
      title: result.session.title,
      branch: branchName,
      sessionId: result.session.id,
      sessionName: result.session.title,
    });
  } catch (err) {
    ctx.send({ type: "error", message: `Fork failed: ${getErrorMessage(err)}` });
  }
}
