import crypto from "node:crypto";
import type { WsClientMessage } from "../../shared/types.js";
import type { ConnectionCtx, AppCtx } from "./types.js";
import { getErrorMessage } from "../validation.js";
import { buildConversationReplay } from "../services/replay.js";
import { forkSession } from "../services/session.js";

type WsRollbackCode = Extract<WsClientMessage, { type: "rollback_code" }>;
type WsRollbackCodeAndChat = Extract<WsClientMessage, { type: "rollback_code_and_chat" }>;
type WsForkSessionFromMessage = Extract<WsClientMessage, { type: "fork_session_from_message" }>;

/**
 * Rollback code only — git reset, chat stays as-is.
 * Client injects a visual divider + system note so Claude knows about the rollback.
 */
export async function handleRollbackCode(ctx: ConnectionCtx & AppCtx, msg: WsRollbackCode): Promise<void> {
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
    const git = ctx.getActiveGitManager();
    await git.rollback(parentCommitHash);
    ctx.send({ type: "rollback_complete", messageIndex, mode: "code", parentCommitHash });
  } catch (err) {
    ctx.send({ type: "error", message: `Rollback failed: ${getErrorMessage(err)}` });
  }
}

/**
 * Rollback code + chat — git reset, old messages become dimmed/read-only,
 * fresh Claude CLI session with conversation replay.
 */
export async function handleRollbackCodeAndChat(ctx: ConnectionCtx & AppCtx, msg: WsRollbackCodeAndChat): Promise<void> {
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
    const git = ctx.getActiveGitManager();
    await git.rollback(parentCommitHash);

    // Build conversation replay from messages up to the rollback point
    const allMessages = ctx.chatHistoryManager.load(sessionId);
    const truncatedMessages = allMessages.slice(0, messageIndex + 1);
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
 * Fork as new session — create a new session (worktree) at the rollback point,
 * with truncated chat history + conversation replay.
 */
export async function handleForkSessionFromMessage(ctx: ConnectionCtx & AppCtx, msg: WsForkSessionFromMessage): Promise<void> {
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

    // Build + store conversation replay on the new session
    const replay = buildConversationReplay(truncatedMessages);
    if (replay) {
      ctx.sessionManager.setConversationReplay(result.session.id, replay);
    }

    // Broadcast updated session list via SSE
    ctx.sseBroadcast("session_list", { sessions: result.sessions });

    ctx.send({
      type: "session_forked",
      sessionId: result.session.id,
      sessionName: result.session.title,
    });
  } catch (err) {
    ctx.send({ type: "error", message: `Fork failed: ${getErrorMessage(err)}` });
  }
}
