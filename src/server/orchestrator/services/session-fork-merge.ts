/**
 * Session fork / merge operations.
 *
 * Extracted from `session.ts` to isolate the cross-session git plumbing
 * (clone-from-cache, branch creation, push/fetch/merge between sibling
 * clones) from the simpler per-session mutations.
 */

import path from "node:path";
import simpleGit from "simple-git";
import type { SessionManager } from "../sessions.js";
import type { GitManager } from "../../shared/git.js";
import type { RepoGit } from "../repo-git.js";
import type { SessionInfo } from "../../shared/types.js";
import { ServiceError } from "./types.js";

/** Fork a session into a new clone with its own branch. */
export async function forkSession(
  sessionManager: SessionManager,
  createRepoGit: (dir: string) => RepoGit,
  getBareCacheDir: (repoUrl: string) => string,
  sessionsRoot: string,
  githubAuthManager: { authenticated: boolean; configureGitCredentials: (dir: string) => void },
  _threadManager: { init: (sessionId: string) => void },
  activeSessionId: string,
  activeSessionDir: string,
  branchName: string,
  startPoint?: string,
): Promise<{ session: SessionInfo; parentSessionId: string; sessions: SessionInfo[] }> {
  const trimmed = branchName.trim();
  if (!trimmed) throw new ServiceError(400, "Branch name is required");
  if (/[\s~^:?*[\\]/.test(trimmed) || trimmed.includes("..")) {
    throw new ServiceError(400, "Invalid branch name");
  }

  const activeSession = sessionManager.get(activeSessionId);

  const crypto = await import("node:crypto");
  const newSessionId = crypto.randomUUID();
  const newSessionDir = path.join(sessionsRoot, newSessionId);
  const newWorkspaceDir = path.join(newSessionDir, "workspace");

  if (activeSession?.remoteUrl) {
    // Clone from bare cache
    const cacheDir = getBareCacheDir(activeSession.remoteUrl);
    const cacheGit = createRepoGit(cacheDir);
    await cacheGit.fetchCache();
    await cacheGit.cloneFromCache(newWorkspaceDir, activeSession.remoteUrl);
    // Checkout the branch at the specified start point
    const branchArgs = ["checkout", "-b", trimmed];
    if (startPoint) branchArgs.push(startPoint);
    await simpleGit(newWorkspaceDir).raw(branchArgs);
  } else {
    // Local repo — clone directly from the active session
    await simpleGit().raw(["clone", "--local", activeSessionDir, newWorkspaceDir]);
    const branchArgs = ["checkout", "-b", trimmed];
    if (startPoint) branchArgs.push(startPoint);
    await simpleGit(newWorkspaceDir).raw(branchArgs);
    // Disable auto-gc
    await simpleGit(newWorkspaceDir).raw(["config", "gc.auto", "0"]);
  }

  // Configure GitHub credentials
  if (githubAuthManager.authenticated) {
    githubAuthManager.configureGitCredentials(newWorkspaceDir);
  }

  // Track in session manager
  const title = `${activeSession?.title ?? "Session"} (${trimmed})`;
  sessionManager.track(newSessionId, title, newWorkspaceDir);
  sessionManager.setBranch(newSessionId, trimmed);
  sessionManager.setBranchRenamed(newSessionId, true);
  if (activeSession?.remoteUrl) {
    sessionManager.setRemoteUrl(newSessionId, activeSession.remoteUrl);
  }

  const newSession = sessionManager.get(newSessionId)!;
  console.log("[server] Forked session:", newSessionId, "branch:", trimmed);
  return {
    session: newSession,
    parentSessionId: activeSessionId,
    sessions: sessionManager.list(),
  };
}

/** Merge a session's branch into the active session. */
export async function mergeSession(
  sessionManager: SessionManager,
  createGitManager: (dir: string) => GitManager,
  activeSessionDir: string,
  sourceSessionId: string,
): Promise<{ success: boolean; message: string; conflicts?: string[] }> {
  const trimmedId = sourceSessionId.trim();
  if (!trimmedId) throw new ServiceError(400, "Source session ID is required");

  const sourceSession = sessionManager.get(trimmedId);
  if (!sourceSession) throw new ServiceError(404, "Source session not found");
  if (!sourceSession.branch) throw new ServiceError(400, "Source session has no branch");

  const git = createGitManager(activeSessionDir);
  const sg = simpleGit(activeSessionDir);

  // With separate clones, we need to get the source branch into this clone.
  // Strategy 1: Push source to origin, then fetch in target (production path).
  // Strategy 2: Add source clone as a local remote and fetch (local/test path).
  let mergeRef = `origin/${sourceSession.branch}`;
  let fetched = false;

  if (sourceSession.workspaceDir) {
    // Try pushing source branch to origin and fetching
    const sourceGit = createGitManager(sourceSession.workspaceDir);
    try {
      await sourceGit.push("origin", sourceSession.branch);
      await sg.fetch("origin", sourceSession.branch);
      fetched = true;
    } catch {
      // Origin push/fetch failed — use local remote instead
    }

    if (!fetched) {
      // Add the source session directory as a temporary local remote
      const remoteName = `merge-source-${trimmedId.slice(0, 8)}`;
      try {
        await sg.addRemote(remoteName, sourceSession.workspaceDir);
      } catch {
        // Remote may already exist from a previous attempt
      }
      try {
        await sg.fetch(remoteName, sourceSession.branch);
        mergeRef = `${remoteName}/${sourceSession.branch}`;
        fetched = true;
      } catch {
        // Fetch from local remote also failed
      }
    }
  }

  let result: Awaited<ReturnType<typeof git.merge>>;
  try {
    result = await git.merge(mergeRef);
  } finally {
    // Clean up temporary merge remotes even if merge throws
    try {
      const remotes = await sg.getRemotes();
      for (const r of remotes) {
        if (r.name.startsWith("merge-source-")) {
          await sg.removeRemote(r.name);
        }
      }
    } catch { /* ignore cleanup errors */ }
  }

  if (result.success) {
    return {
      success: true,
      message: `Merged branch '${sourceSession.branch}' successfully`,
    };
  }
  return {
    success: false,
    message: `Merge conflict on branch '${sourceSession.branch}'`,
    conflicts: result.conflicts,
  };
}
