import type { WsClientMessage } from "../types.js";
import type { HandlerContext } from "./types.js";
import { getErrorMessage } from "../validation.js";
import { scanFileTree } from "../file-tree.js";

type WsGetChatHistory = Extract<WsClientMessage, { type: "get_chat_history" }>;

export async function handleListSessions(ctx: HandlerContext): Promise<void> {
  const sessions = ctx.sessionManager.list();
  // Lazy-populate remoteUrl for sessions that have a workspace but no cached URL.
  // One-time cost per session; subsequent calls are instant.
  await Promise.all(
    sessions.map(async (session) => {
      if (session.workspaceDir && !session.remoteUrl) {
        try {
          const git = ctx.createGitManager(session.workspaceDir);
          const remotes = await git.getRemotes();
          const origin = remotes.find((r) => r.name === "origin");
          if (origin?.url) {
            ctx.sessionManager.setRemoteUrl(session.id, origin.url);
            session.remoteUrl = origin.url;
          }
        } catch {
          // Workspace may not exist or not be a git repo — skip
        }
      }
    })
  );
  ctx.send({ type: "session_list", sessions });
}

export function handleNewSession(ctx: HandlerContext): void {
  // Detach from current runner (it keeps running in the background)
  ctx.detachFromRunner();
  // Clear active session — next send_message or apply_template will create a new one
  ctx.setActiveAppSessionId(undefined);
  ctx.setActiveSessionDir(null);
  ctx.send({ type: "session_list", sessions: ctx.sessionManager.list() });
}

export async function handleGetChatHistory(ctx: HandlerContext, msg: WsGetChatHistory): Promise<void> {
  const session = ctx.sessionManager.get(msg.sessionId);

  // Check if a worktree session's directory is missing before activating
  if (session?.sessionType === "worktree" && session.workspaceDir) {
    const fsModule = await import("node:fs/promises");
    const dirExists = await fsModule.stat(session.workspaceDir).then(() => true, () => false);
    if (!dirExists) {
      // Still send the chat history so the user can see past messages,
      // but warn that the workspace is gone.
      const messages = ctx.chatHistoryManager.load(msg.sessionId);
      ctx.send({ type: "chat_history", sessionId: msg.sessionId, messages });
      ctx.send({
        type: "error",
        message: "This session's workspace is no longer available. The worktree may have been cleaned up.",
      });
      return;
    }
  }

  // Activate the requested session (session switch)
  await ctx.activateSession(msg.sessionId);
  const messages = ctx.chatHistoryManager.load(msg.sessionId);
  ctx.send({ type: "chat_history", sessionId: msg.sessionId, messages });

  // Send git log and file tree now that the session is fully activated.
  // The client must NOT send separate get_git_log / get_file_tree messages
  // during session switch — those would race with activateSession (async)
  // and return data from the *previous* session's workspace directory.
  try {
    const git = ctx.getActiveGitManager();
    const commits = await git.log();
    ctx.send({ type: "git_log", commits });
  } catch {
    // No workspace dir (e.g. blank session) — send empty log
    ctx.send({ type: "git_log", commits: [] });
  }
  try {
    const dir = ctx.getActiveDir();
    const tree = await scanFileTree(dir);
    ctx.send({ type: "file_tree", tree });
  } catch (err) {
    ctx.send({ type: "error", message: `Failed to scan file tree: ${getErrorMessage(err)}` });
  }
}

