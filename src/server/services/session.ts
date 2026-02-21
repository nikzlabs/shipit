/**
 * Session services — reads (list, status, history, worktrees) and mutations
 * (rename, archive).
 */

import path from "node:path";
import fs from "node:fs/promises";
import type { SessionManager } from "../sessions.js";
import type { GitManager } from "../git.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { SessionInfo } from "../types.js";
import { ServiceError } from "./types.js";

// ---- Read operations ----

/**
 * List all sessions, lazily populating remote URLs for sessions that have
 * a workspace but no cached URL.
 */
export async function listSessions(
  sessionManager: SessionManager,
  createGitManager: (dir: string) => GitManager,
): Promise<SessionInfo[]> {
  const sessions = sessionManager.list();
  await Promise.all(
    sessions.map(async (session) => {
      if (session.workspaceDir && !session.remoteUrl) {
        try {
          const git = createGitManager(session.workspaceDir);
          const remotes = await git.getRemotes();
          const origin = remotes.find((r) => r.name === "origin");
          if (origin?.url) {
            sessionManager.setRemoteUrl(session.id, origin.url);
            session.remoteUrl = origin.url;
          }
        } catch {
          // Workspace may not exist or not be a git repo — skip
        }
      }
    })
  );
  return sessions;
}

/** Get the session status (running, queue length) from the runner registry. */
export function getSessionStatus(
  runnerRegistry: SessionRunnerRegistry,
  sessionId: string,
): { running: boolean; queueLength: number } {
  const runner = runnerRegistry.get(sessionId);
  return {
    running: runner?.running ?? false,
    queueLength: runner?.queueLength ?? 0,
  };
}

/** Get chat messages for a session (read-only, no activation side effects). */
export function getChatHistory(
  chatHistoryManager: { load: (sessionId: string) => unknown[] },
  sessionId: string,
) {
  return chatHistoryManager.load(sessionId);
}

/** Get worktrees (sibling sessions sharing the same repo). */
export function listWorktrees(
  sessionManager: SessionManager,
  sessionId: string,
): Array<{ sessionId: string; branch: string; path: string }> {
  const session = sessionManager.get(sessionId);
  const siblings = session?.remoteUrl
    ? sessionManager.findAllByRemoteUrl(session.remoteUrl)
    : [session].filter(Boolean) as SessionInfo[];

  const worktrees: Array<{ sessionId: string; branch: string; path: string }> = [];
  for (const s of siblings) {
    if (s.workspaceDir && s.branch) {
      worktrees.push({ sessionId: s.id, branch: s.branch, path: s.workspaceDir });
    }
  }
  return worktrees;
}

// ---- Mutation operations ----

/** Rename a session. Returns the updated session or throws ServiceError. */
export function renameSession(
  sessionManager: SessionManager,
  sessionId: string,
  title: string,
): SessionInfo {
  const trimmed = title.trim();
  if (!trimmed) throw new ServiceError(400, "Session title cannot be empty");
  const renamed = sessionManager.rename(sessionId, trimmed);
  if (!renamed) throw new ServiceError(404, "Session not found");
  return renamed;
}

/** Archive a session, cleaning up worktrees and shared repos. */
export async function archiveSession(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  createGitManager: (dir: string) => GitManager,
  getSharedRepoDir: (url: string) => string,
  sessionId: string,
): Promise<{ sessions: SessionInfo[] }> {
  const session = sessionManager.get(sessionId);

  // Worktree cleanup
  if (session?.sessionType === "worktree" && session.workspaceDir) {
    try {
      let repoDir: string | null = null;
      if (session.remoteUrl) {
        repoDir = getSharedRepoDir(session.remoteUrl);
      } else {
        const dotGit = path.join(session.workspaceDir, ".git");
        const stat = await fs.stat(dotGit).catch(() => null);
        if (stat?.isFile()) {
          const content = await fs.readFile(dotGit, "utf-8");
          const match = content.match(/gitdir:\s*(.+)/);
          if (match) {
            const gitDir = path.resolve(path.dirname(dotGit), match[1].trim());
            const mainGitDir = path.resolve(gitDir, "..", "..");
            repoDir = path.dirname(mainGitDir);
          }
        }
      }
      if (repoDir) {
        const repoGit = createGitManager(repoDir);
        await repoGit.removeWorktree(session.workspaceDir);
        if (session.branch) {
          await repoGit.deleteBranch(session.branch);
        }
      }
    } catch (err) {
      console.warn("[server] Worktree cleanup failed:", String(err));
    }
  }

  // Dispose runner
  runnerRegistry.dispose(sessionId);

  // Archive
  sessionManager.archive(sessionId);

  // Clean up shared repo if no remaining sessions
  if (session?.remoteUrl) {
    const remaining = sessionManager.findAllByRemoteUrl(session.remoteUrl);
    if (remaining.length === 0) {
      try {
        const repoDir = getSharedRepoDir(session.remoteUrl);
        await fs.rm(repoDir, { recursive: true, force: true });
        console.log("[server] Cleaned up shared repo (no remaining sessions):", repoDir);
      } catch (err) {
        console.warn("[server] Shared repo cleanup failed:", String(err));
      }
    }
  }

  return { sessions: sessionManager.list() };
}
