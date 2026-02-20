import type { WsClientMessage } from "../types.js";
import type { HandlerContext } from "./types.js";

type WsArchiveSession = Extract<WsClientMessage, { type: "archive_session" }>;
type WsRenameSession = Extract<WsClientMessage, { type: "rename_session" }>;
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
  // Clear active session — next send_message or apply_template will create a new one
  ctx.setActiveAppSessionId(undefined);
  ctx.setActiveSessionDir(null);
  // Clear the queue when starting a new session
  const queue = ctx.getMessageQueue();
  if (queue.length > 0) {
    queue.length = 0;
    ctx.send({ type: "queue_updated", queue: [] });
  }
  ctx.send({ type: "session_list", sessions: ctx.sessionManager.list() });
}

export async function handleArchiveSession(ctx: HandlerContext, msg: WsArchiveSession): Promise<void> {
  const sessionToArchive = ctx.sessionManager.get(msg.sessionId);

  // If archiving a worktree session, clean up the worktree + branch
  if (sessionToArchive?.sessionType === "worktree" && sessionToArchive.workspaceDir) {
    try {
      const path = await import("node:path");
      const fs = await import("node:fs/promises");
      let repoDir: string | null = null;
      if (sessionToArchive.remoteUrl) {
        repoDir = ctx.getSharedRepoDir(sessionToArchive.remoteUrl);
      } else {
        // Standalone worktree: read .git file to find main repo
        const dotGit = path.join(sessionToArchive.workspaceDir, ".git");
        const stat = await fs.stat(dotGit).catch(() => null);
        if (stat?.isFile()) {
          const content = await fs.readFile(dotGit, "utf-8");
          const match = content.match(/gitdir:\s*(.+)/);
          if (match) {
            // gitdir points to <main-repo>/.git/worktrees/<name>
            const gitDir = path.resolve(path.dirname(dotGit), match[1].trim());
            const mainGitDir = path.resolve(gitDir, "..", "..");
            repoDir = path.dirname(mainGitDir);
          }
        }
      }
      if (repoDir) {
        const repoGit = ctx.createGitManager(repoDir);
        await repoGit.removeWorktree(sessionToArchive.workspaceDir);
        if (sessionToArchive.branch) {
          await repoGit.deleteBranch(sessionToArchive.branch);
        }
      }
    } catch (err) {
      const { getErrorMessage } = await import("../validation.js");
      console.warn("[server] Worktree cleanup failed:", getErrorMessage(err));
    }
  }

  // If archiving the active session, clear it
  if (msg.sessionId === ctx.getActiveAppSessionId()) {
    ctx.setActiveAppSessionId(undefined);
    ctx.setActiveSessionDir(null);
  }
  ctx.sessionManager.archive(msg.sessionId);
  ctx.send({ type: "session_list", sessions: ctx.sessionManager.list() });
}

export function handleRenameSession(ctx: HandlerContext, msg: WsRenameSession): void {
  const trimmed = msg.title.trim();
  if (!trimmed) {
    ctx.send({ type: "error", message: "Session title cannot be empty" });
  } else {
    const renamed = ctx.sessionManager.rename(msg.sessionId, trimmed);
    if (renamed) {
      ctx.send({ type: "session_renamed", session: renamed });
    } else {
      ctx.send({ type: "error", message: "Session not found" });
    }
  }
}

export async function handleGetChatHistory(ctx: HandlerContext, msg: WsGetChatHistory): Promise<void> {
  // Activate the requested session (session switch)
  await ctx.activateSession(msg.sessionId);
  const messages = ctx.chatHistoryManager.load(msg.sessionId);
  ctx.send({ type: "chat_history", sessionId: msg.sessionId, messages });
}
