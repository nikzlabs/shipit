/**
 * Session services — reads (list, status, history, siblings) and mutations
 * (rename, archive, unarchive, delete, mark-merged).
 *
 * Fork / merge live in `./session-fork-merge.js` and the agent-spawned child
 * session feature lives in `./child-sessions.js`. Both are re-exported below
 * so existing callsites can keep importing from `./session.js` (or the
 * services barrel) without changes.
 */

import fs from "node:fs/promises";
import simpleGit from "simple-git";
import type { SessionManager } from "../sessions.js";
import type { ChatHistoryManager } from "../chat-history.js";
import type { UsageManager } from "../usage.js";
import type { GitManager } from "../../shared/git.js";
import type { RepoGit } from "../repo-git.js";
import { ensureBareCache } from "../repo-git.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { SessionInfo } from "../../shared/types.js";
import type { RepoStore } from "../repo-store.js";
import type { GitHubAuthManager } from "../github-auth.js";
import { generateBranchPrefix } from "../git-utils.js";
import { ServiceError } from "./types.js";

// Re-exports so external consumers continue to resolve these from "./session.js".
export { forkSession, mergeSession } from "./session-fork-merge.js";
export {
  DEFAULT_MAX_ACTIVE_SPAWNED_SESSIONS,
  DEFAULT_MAX_SPAWNED_SESSIONS_PER_TURN,
  DEFAULT_WAIT_FOR_CHILD_IDLE_MS,
  MAX_WAIT_FOR_CHILD_IDLE_MS,
  spawnChildSession,
  listSpawnedChildren,
  getSpawnedChild,
  sendChildMessage,
  waitForChildIdle,
  assertArchivableChild,
} from "./child-sessions.js";
export type {
  SpawnChildSessionOptions,
  SpawnChildSessionResult,
  ChildSessionView,
  ChildViewProjections,
  SendChildMessageResult,
  WaitForChildIdleResult,
} from "./child-sessions.js";

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

    // Ensure the bare cache exists — re-clones if missing or corrupt.
    // Shared with the claim-session slow path so behavior stays consistent.
    const { git: cacheGit, recovered } = await ensureBareCache(
      cacheDir,
      session.remoteUrl,
      createRepoGit,
    );
    if (recovered) {
      // Keep the repo store in sync — the previous code path called these
      // unconditionally when it ran its own existence check. Idempotent
      // (`add` is a no-op for an already-known repo, `setReady` is too).
      repoStore.add(session.remoteUrl);
      repoStore.setReady(session.remoteUrl);
    }

    // Normalize the cache's origin URL to the plain form. Caches cloned by
    // earlier code paths may have a token embedded in their origin URL —
    // overwriting it here means any subsequent error message (including the
    // bare cache's own config dump) cannot leak the token. Credential
    // resolution happens via the global helper, not the URL.
    if (githubAuthManager.authenticated) {
      await cacheGit.setRemoteUrl(session.remoteUrl);
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
 *
 * `containerManager` actually destroys the agent container before we `fs.rm`
 * the workspace dir. `runnerRegistry.dispose()` deliberately leaves the
 * container alive (so transient lifecycle events can reconnect to it), so
 * without this step the container survives archive with its workspace bind
 * mount pinned to the about-to-be-unlinked inode. After unarchive re-clones
 * a fresh inode at the same path, reconnects to the orphan container see
 * an empty `/workspace`. Optional only so tests without Docker can omit it.
 */
export async function archiveSession(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  getBareCacheDir: (url: string) => string,
  sessionId: string,
  pruneVolumes?: (sessionId: string) => Promise<void>,
  containerManager?: { destroy(sessionId: string): Promise<void> } | null,
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

  // Destroy the agent container so its workspace bind mount is released
  // before we unlink the host directory. See the docblock above for why
  // dispose() alone isn't enough.
  if (containerManager) {
    try {
      await containerManager.destroy(sessionId);
    } catch (err) {
      console.warn(`[server] Failed to destroy container for ${sessionId}:`, String(err));
    }
  }

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

  // Clean up the session's git clone — the bare cache + unarchive flow
  // re-creates it from scratch on restore.
  if (session?.workspaceDir) {
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
 * Also deletes the remote head branch (best-effort) for the just-merged
 * session so feature branches don't accumulate on GitHub. Many repos enable
 * "automatically delete head branches" upstream, in which case our delete is
 * a harmless no-op; for repos without that setting, this is the cleanup.
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
  createRepoGit?: (dir: string) => RepoGit,
  githubAuthManager?: GitHubAuthManager,
  containerManager?: { destroy(sessionId: string): Promise<void> } | null,
): Promise<{ sessions: SessionInfo[] }> {
  sessionManager.markMerged(sessionId);

  // Scope pruning to the same repository as the merged session.
  const session = sessionManager.get(sessionId);
  if (!session?.remoteUrl) {
    return { sessions: sessionManager.list() };
  }

  // Delete the remote head branch for the just-merged session. Best-effort:
  // - GitHub's "automatically delete head branches" setting may have already
  //   removed it (RepoGit.deleteBranch swallows "remote ref does not exist").
  // - Token may have rotated since the bare cache was cloned; refresh the
  //   embedded credentials before pushing (mirrors `unarchiveSession`).
  // - Any other failure (network, permissions) is logged and ignored —
  //   branch cleanup is housekeeping, not a blocker for marking merged.
  if (createRepoGit && session.branch) {
    try {
      const cacheDir = getBareCacheDir(session.remoteUrl);
      const cacheGit = createRepoGit(cacheDir);
      // Normalize origin URL to the plain form (no embedded token). The
      // global credential helper supplies the token on push; an embedded
      // URL would leak it if the delete-branch push errors out.
      if (githubAuthManager?.authenticated) {
        await cacheGit.setRemoteUrl(session.remoteUrl);
      }
      await cacheGit.deleteBranch(session.branch);
    } catch (err) {
      console.warn(
        `[server] Branch cleanup failed for merged session ${sessionId} (branch ${session.branch}):`,
        String(err),
      );
    }
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
<<<<<<< HEAD
    // Skip sessions with live (non-archived) child sessions. Archiving a
    // parent disposes its runner, removes its workspace, and drops its
    // volumes — but the children are independent sessions whose users may
    // still be working in them, and they reference the parent via
    // `parent_session_id`. Leaving the parent alive keeps the breadcrumb
    // intact until the user explicitly archives it (which still works via
    // the UI / DELETE route — this guard only fires on the automatic
    // post-merge prune).
    if (sessionManager.findChildren(excess.id).length > 0) {
      continue;
    }
    await archiveSession(sessionManager, runnerRegistry, getBareCacheDir, excess.id, pruneVolumes);
=======
    await archiveSession(sessionManager, runnerRegistry, getBareCacheDir, excess.id, pruneVolumes, containerManager);
>>>>>>> fdef72212 (PR #745 now covers both the cleanup and the fix.)
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
