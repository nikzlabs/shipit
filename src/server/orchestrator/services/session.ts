/**
 * Session services — reads (list, status, history, siblings) and mutations
 * (rename, archive, fork, unarchive, merge).
 */

import path from "node:path";
import fs from "node:fs/promises";
import simpleGit from "simple-git";
import type { SessionManager } from "../sessions.js";
import type { ChatHistoryManager } from "../chat-history.js";
import type { UsageManager } from "../usage.js";
import type { GitManager } from "../../shared/git.js";
import type { RepoGit } from "../repo-git.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { SessionInfo } from "../../shared/types.js";
import type { RepoStore } from "../repo-store.js";
import type { GitHubAuthManager } from "../github-auth.js";
import { generateBranchPrefix } from "../git-utils.js";
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

/** Get sibling sessions sharing the same repo. */
export function listWorktrees(
  sessionManager: SessionManager,
  sessionId: string,
): { sessionId: string; branch: string; path: string }[] {
  const session = sessionManager.get(sessionId);
  const siblings = session?.remoteUrl
    ? sessionManager.findAllByRemoteUrl(session.remoteUrl)
    : [session].filter(Boolean) as SessionInfo[];

  const worktrees: { sessionId: string; branch: string; path: string }[] = [];
  for (const s of siblings) {
    if (s.workspaceDir && s.branch) {
      worktrees.push({ sessionId: s.id, branch: s.branch, path: s.workspaceDir });
    }
  }
  return worktrees;
}

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

/** List all sessions (active + archived, excluding warm). */
export function listAllSessions(
  sessionManager: SessionManager,
): SessionInfo[] {
  return sessionManager.listAll();
}

/** Unarchive (restore) a session, recreating clone if needed. */
export async function unarchiveSession(
  sessionManager: SessionManager,
  createRepoGit: (dir: string) => RepoGit,
  getBareCacheDir: (url: string) => string,
  githubAuthManager: GitHubAuthManager,
  repoStore: RepoStore,
  sessionId: string,
): Promise<{ session: SessionInfo; sessions: SessionInfo[] }> {
  const session = sessionManager.get(sessionId);
  if (!session?.archived) throw new ServiceError(404, "Session not found or not archived");

  // Sessions with remoteUrl need their clone restored
  if (session.remoteUrl && session.workspaceDir) {
    const cacheDir = getBareCacheDir(session.remoteUrl);

    // Ensure bare cache exists (re-clone if it was cleaned up)
    // eslint-disable-next-line no-restricted-syntax -- stat existence-check idiom
    const cacheExists = await fs.stat(cacheDir).then(() => true, () => false);
    if (!cacheExists) {
      await fs.mkdir(cacheDir, { recursive: true });
      const cloneUrl = githubAuthManager.getAuthenticatedCloneUrl(session.remoteUrl);
      const cacheGit = createRepoGit(cacheDir);
      await cacheGit.cloneBare(cloneUrl);
      repoStore.add(session.remoteUrl);
      repoStore.setReady(session.remoteUrl);
    }

    const cacheGit = createRepoGit(cacheDir);

    // Refresh remote URL with current token before fetching
    if (githubAuthManager.authenticated) {
      const freshUrl = githubAuthManager.getAuthenticatedCloneUrl(session.remoteUrl);
      await cacheGit.setRemoteUrl(freshUrl);
    }

    // Remove stale remnants
    await fs.rm(session.workspaceDir, { recursive: true, force: true });

    // Clone from bare cache into session dir
    // Retry clone (lock contention)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await cacheGit.fetchCache();
        await cacheGit.cloneFromCache(session.workspaceDir, session.remoteUrl);
        break;
      } catch (cloneErr) {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        } else {
          throw cloneErr;
        }
      }
    }

    // Create a new branch
    const newBranch = generateBranchPrefix();
    let startPoint: string | undefined;
    try {
      const defaultBranch = await cacheGit.getDefaultBranch();
      if (defaultBranch && !defaultBranch.includes("(")) {
        startPoint = `origin/${defaultBranch}`;
      }
    } catch {
      // Fallback: let git use HEAD
    }

    const branchArgs = ["checkout", "-b", newBranch];
    if (startPoint) branchArgs.push(startPoint);
    await simpleGit(session.workspaceDir).raw(branchArgs);

    // Configure credentials
    if (githubAuthManager.authenticated) {
      githubAuthManager.configureGitCredentials(session.workspaceDir);
    }

    sessionManager.setBranch(sessionId, newBranch);
  }

  sessionManager.unarchive(sessionId);
  const updated = sessionManager.get(sessionId);
  if (!updated) throw new ServiceError(404, "Session not found");
  return { session: updated, sessions: sessionManager.list() };
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

/**
 * Archive a session, cleaning up clone directory.
 *
 * `pruneVolumes` is invoked when no runner exists at archive time (so the
 * `removeVolumesOnDispose` flag couldn't fire) to prune named volumes
 * labeled `shipit-session=<sessionId>`. Optional: when omitted, the
 * fallback prune is skipped — used by tests so we don't shell out to a
 * real Docker daemon. Production wires this to `pruneSessionVolumes`
 * from `disk-janitor.ts`.
 */
export async function archiveSession(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  getBareCacheDir: (url: string) => string,
  sessionId: string,
  pruneVolumes?: (sessionId: string) => Promise<void>,
): Promise<{ sessions: SessionInfo[] }> {
  const session = sessionManager.get(sessionId);

  // Signal the compose-stop hook (in app-lifecycle.ts's setupServiceManager
  // disposed handler) to drop the stack's named volumes. Archive is a
  // genuine "this session is going away" event — any per-session compose
  // volumes (user-declared node_modules caches, etc.) should be reclaimed.
  const runner = runnerRegistry.get(sessionId);
  const runnerWasAlive = runner !== undefined;
  if (runner && "removeVolumesOnDispose" in runner) {
    (runner as { removeVolumesOnDispose: boolean }).removeVolumesOnDispose = true;
  }

  // Dispose runner (forced — user explicitly archived this session, so we
  // tear it down even if an agent is still running)
  runnerRegistry.dispose(sessionId, { force: true });

  // Fallback path: if no runner existed (e.g. idle eviction already
  // disposed it), the `removeVolumesOnDispose` flag never had a chance
  // to fire — the prior compose-down ran without `--volumes` and the
  // named volumes are still on the daemon. Prune them now by label. This
  // is the case for auto-archive of merged sessions, where idle eviction
  // typically wins the race. When the runner WAS alive, the flag-driven
  // path already did the work and the label-scoped prune is unnecessary.
  // Tests omit `pruneVolumes` so we don't shell out to a real Docker
  // daemon from unit / integration tests.
  if (!runnerWasAlive && pruneVolumes) {
    await pruneVolumes(sessionId);
  }

  // Clean up session workspace directory for repo-backed clones only.
  // Standalone sessions preserve their directory so they can be unarchived.
  if (session?.remoteUrl && session?.workspaceDir) {
    try {
      await fs.rm(session.workspaceDir, { recursive: true, force: true });
      console.log("[server] Removed session workspace:", session.workspaceDir);
    } catch (err) {
      console.warn("[server] Session workspace cleanup failed:", String(err));
    }
  }

  // Archive
  sessionManager.archive(sessionId);

  // Clean up bare cache if no remaining sessions reference this repo
  if (session?.remoteUrl) {
    const remaining = sessionManager.findAllByRemoteUrl(session.remoteUrl);
    if (remaining.length === 0) {
      try {
        const cacheDir = getBareCacheDir(session.remoteUrl);
        await fs.rm(cacheDir, { recursive: true, force: true });
        console.log("[server] Cleaned up bare cache (no remaining sessions):", cacheDir);
      } catch (err) {
        console.warn("[server] Bare cache cleanup failed:", String(err));
      }
    }
  }

  return { sessions: sessionManager.list() };
}

/** Maximum number of merged sessions to keep per repository before archiving old ones. */
const MAX_MERGED_SESSIONS_PER_REPO = 3;

/**
 * Mark a session as merged and archive excess merged sessions beyond the
 * per-repository limit. Called when a PR merge is detected — keeps the most
 * recent merged sessions alive.
 *
 * The limit is applied **per repository**: only merged sessions in the same
 * repo as the just-merged session are considered for archiving. Sessions in
 * other repos are left alone, even if they themselves have many merged
 * sessions — pruning only runs in the repo where activity just occurred.
 */
export async function markMergedAndPruneExcess(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  getBareCacheDir: (url: string) => string,
  sessionId: string,
  pruneVolumes?: (sessionId: string) => Promise<void>,
): Promise<{ sessions: SessionInfo[] }> {
  sessionManager.markMerged(sessionId);

  // Scope pruning to the same repository as the merged session.
  // Sessions without a remoteUrl (e.g. standalone sessions) cannot be merged
  // via PRs anyway, so this branch is effectively unreachable — but we guard
  // against it to keep the function total.
  const session = sessionManager.get(sessionId);
  if (!session?.remoteUrl) {
    return { sessions: sessionManager.list() };
  }

  const merged = sessionManager.listMergedNotArchivedByRemoteUrl(session.remoteUrl);
  // Archive oldest merged sessions beyond the per-repo limit
  // (list is sorted newest-first). Forward `pruneVolumes` so the
  // auto-archive path reclaims per-session named volumes immediately —
  // idle eviction has usually disposed the runner by now, so without
  // this the named volumes would leak until the next orchestrator
  // restart's disk-janitor pass.
  const toArchive = merged.slice(MAX_MERGED_SESSIONS_PER_REPO);
  for (const excess of toArchive) {
    await archiveSession(sessionManager, runnerRegistry, getBareCacheDir, excess.id, pruneVolumes);
  }

  return { sessions: sessionManager.list() };
}

/**
 * Delete a session and cascade to related stores (chat history, usage).
 * Use this instead of calling sessionManager.delete() directly.
 */
export function deleteSession(
  sessionManager: SessionManager,
  sessionId: string,
  chatHistoryManager?: ChatHistoryManager,
  usageManager?: UsageManager,
): boolean {
  const deleted = sessionManager.delete(sessionId);
  if (deleted) {
    chatHistoryManager?.delete(sessionId);
    usageManager?.delete(sessionId);
  }
  return deleted;
}
