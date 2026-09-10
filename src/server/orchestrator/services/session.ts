import fs from "node:fs/promises";
import path from "node:path";
import { safeSimpleGit } from "../../shared/git-hooks-guard.js";
import type { SessionManager } from "../sessions.js";
import { holdsActiveReservation } from "../sessions.js";
import type { ChatHistoryManager, PersistedMessage } from "../chat-history.js";
import { projectMessagesForWire } from "../transcript-projection.js";
import type { UsageManager } from "../usage.js";
import type { GitManager } from "../../shared/git.js";
import type { RepoGit } from "../repo-git.js";
import { ensureBareCache } from "../repo-git.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { SessionInfo } from "../../shared/types.js";
import type { RepoStore } from "../repo-store.js";
import type { GitHubAuthManager } from "../github-auth.js";
import { generateBranchPrefix } from "../git-utils.js";
import { handWorkspaceBackToWorker } from "../session-worker-uid.js";
import { materializeLfsWithWarning } from "../git-lfs.js";
import { reclaimRegenerableSessionDirs } from "../disk-utils.js";
import { ServiceError } from "./types.js";
import { validateString, validateStringArray } from "./validation.js";

export { forkSession, forkReportSinks, mergeSession, type ForkReportSinks } from "./session-fork-merge.js";
export {
  DEFAULT_MAX_ACTIVE_SPAWNED_SESSIONS,
  DEFAULT_MAX_SPAWNED_SESSIONS_PER_TURN,
  DEFAULT_MAX_SHIPIT_FIX_SESSIONS_PER_TURN,
  DEFAULT_WAIT_FOR_CHILD_IDLE_MS,
  MAX_WAIT_FOR_CHILD_IDLE_MS,
  spawnChildSession,
  listSpawnedChildren,
  getSpawnedChild,
  sendChildMessage,
  ResolvedChildMessageError,
  waitForChildIdle,
  assertArchivableChild,
  registerMergeWatch,
} from "./child-sessions.js";
export type {
  SpawnChildSessionOptions,
  SpawnChildSessionResult,
  ChildSessionView,
  ChildViewProjections,
  SendChildMessageResult,
  WaitForChildIdleResult,
  RegisterMergeWatchResult,
} from "./child-sessions.js";

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
          // The workspace may be absent or have no git repository.
        }
      }
    })
  );
  return sessions;
}

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

// Project only browser reads; internal history consumers need the full bodies.
export function getChatHistory(
  chatHistoryManager: { load: (sessionId: string) => unknown[] },
  sessionId: string,
) {
  return projectMessagesForWire(sessionId, chatHistoryManager.load(sessionId) as PersistedMessage[]);
}

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

export function listAllSessions(
  sessionManager: SessionManager,
): SessionInfo[] {
  return sessionManager.listAll();
}

// Orchestrator checkout disables LFS smudge, so restored trees need an explicit pull.
async function materializeLfsAndChown(workspaceDir: string, repoUrl: string | undefined): Promise<void> {
  const result = await materializeLfsWithWarning(workspaceDir, repoUrl ?? workspaceDir, (message) =>
    console.warn(`[session] ${message}`),
  );
  // Use the object-aware handback: cache-linked objects must retain their owner.
  if (result.status === "materialized") handWorkspaceBackToWorker(workspaceDir);
}

function clearPriorPrState(
  sessionManager: SessionManager,
  prStatusPoller: UnarchivePrStatusPoller | undefined,
  sessionId: string,
): void {
  sessionManager.clearPriorPrRecord(sessionId);
  prStatusPoller?.clearPersisted(sessionId);
}

export interface UnarchivePrStatusPoller {
  clearPersisted(sessionId: string): void;
}

export async function unarchiveSession(
  sessionManager: SessionManager,
  createRepoGit: (dir: string) => RepoGit,
  getBareCacheDir: (url: string) => string,
  githubAuthManager: GitHubAuthManager,
  repoStore: RepoStore,
  sessionId: string,
  prStatusPoller?: UnarchivePrStatusPoller,
): Promise<{ session: SessionInfo; sessions: SessionInfo[] }> {
  const session = sessionManager.get(sessionId);
  if (!session || (session.diskTier !== "evicted" && !session.userArchived)) {
    throw new ServiceError(404, "Session not found or not restorable");
  }

  if (session.remoteUrl && session.workspaceDir) {
    const cacheDir = getBareCacheDir(session.remoteUrl);

    const { git: cacheGit, recovered } = await ensureBareCache(
      cacheDir,
      session.remoteUrl,
      createRepoGit,
    );
    if (recovered) {
      repoStore.add(session.remoteUrl);
      repoStore.setReady(session.remoteUrl);
    }

    if (githubAuthManager.authenticated) {
      await cacheGit.setRemoteUrl(session.remoteUrl);
    }

    await fs.rm(session.workspaceDir, { recursive: true, force: true });

    // Bypass the cache TTL so the new branch uses current upstream if available.
    try {
      await cacheGit.fetchCache(0);
    } catch (fetchErr) {
      console.warn(
        `[unarchiveSession] fetchCache failed for ${session.remoteUrl}; restoring from stale cache:`,
        fetchErr,
      );
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
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

    const newBranch = generateBranchPrefix();
    let startPoint: string | undefined;
    try {
      const defaultBranch = await cacheGit.getDefaultBranch();
      if (defaultBranch && !defaultBranch.includes("(")) {
        startPoint = `origin/${defaultBranch}`;
      }
    } catch {
      // Let git use HEAD.
    }

    const branchArgs = ["checkout", "-b", newBranch];
    if (startPoint) branchArgs.push(startPoint);
    await safeSimpleGit(session.workspaceDir).raw(branchArgs);

    if (githubAuthManager.authenticated) {
      githubAuthManager.configureGitCredentials(session.workspaceDir);
    }

    await materializeLfsAndChown(session.workspaceDir, session.remoteUrl);

    sessionManager.setBranch(sessionId, newBranch);
  }

  // The new branch must not inherit the previous PR's merge record or snapshot.
  clearPriorPrState(sessionManager, prStatusPoller, sessionId);

  sessionManager.unarchive(sessionId);
  const updated = sessionManager.get(sessionId);
  if (!updated) throw new ServiceError(404, "Session not found");
  return { session: updated, sessions: sessionManager.list() };
}

// Concurrent activations must share a restore so one cannot remove the other's clone.
const inFlightRestores = new Map<string, Promise<boolean>>();

/** Restore a live session's existing branch; unarchiveSession starts a new branch. */
export function restoreSessionWorkspace(
  sessionManager: SessionManager,
  createRepoGit: (dir: string) => RepoGit,
  getBareCacheDir: (url: string) => string,
  githubAuthManager: GitHubAuthManager,
  repoStore: RepoStore,
  sessionId: string,
): Promise<boolean> {
  const existing = inFlightRestores.get(sessionId);
  if (existing) return existing;
  const p = restoreSessionWorkspaceImpl(
    sessionManager, createRepoGit, getBareCacheDir, githubAuthManager, repoStore, sessionId,
  ).finally(() => inFlightRestores.delete(sessionId));
  inFlightRestores.set(sessionId, p);
  return p;
}

async function restoreSessionWorkspaceImpl(
  sessionManager: SessionManager,
  createRepoGit: (dir: string) => RepoGit,
  getBareCacheDir: (url: string) => string,
  githubAuthManager: GitHubAuthManager,
  repoStore: RepoStore,
  sessionId: string,
): Promise<boolean> {
  const session = sessionManager.get(sessionId);
  if (!session) return false;

  if (!session.remoteUrl || !session.workspaceDir) {
    if (session.workspaceDir) {
      // eslint-disable-next-line no-restricted-syntax -- stat existence-check idiom (matches the rest of this codebase)
      const present = await fs.stat(session.workspaceDir).then(() => true, () => false);
      if (!present) {
        throw new ServiceError(410, "Session workspace is gone and has no remote to restore from.");
      }
    }
    return false;
  }

  const evicted = session.diskTier === "evicted";
  const gitDir = path.join(session.workspaceDir, ".git");
  // eslint-disable-next-line no-restricted-syntax -- stat existence-check idiom (matches the rest of this codebase)
  const workspacePresent = await fs.stat(gitDir).then((s) => s.isDirectory(), () => false);

  if (workspacePresent && !evicted) return false;
  if (workspacePresent && evicted) {
    sessionManager.setDiskTier(sessionId, "hot");
    return false;
  }

  const cacheDir = getBareCacheDir(session.remoteUrl);
  const { git: cacheGit, recovered } = await ensureBareCache(cacheDir, session.remoteUrl, createRepoGit);
  if (recovered) {
    repoStore.add(session.remoteUrl);
    repoStore.setReady(session.remoteUrl);
  }
  if (githubAuthManager.authenticated) {
    await cacheGit.setRemoteUrl(session.remoteUrl);
  }

  await fs.rm(session.workspaceDir, { recursive: true, force: true });

  // Fetch pushed session branches before the local clone; stale cache is a fallback.
  try {
    await cacheGit.fetchCache(0);
  } catch (fetchErr) {
    console.warn(
      `[restoreSessionWorkspace] fetchCache failed for ${session.remoteUrl}; restoring from stale cache:`,
      fetchErr,
    );
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
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

  if (session.branch) {
    const wsGit = safeSimpleGit(session.workspaceDir);
    try {
      await wsGit.raw(["checkout", session.branch]);
    } catch {
      let startPoint: string | undefined;
      try {
        const defaultBranch = await cacheGit.getDefaultBranch();
        if (defaultBranch && !defaultBranch.includes("(")) startPoint = `origin/${defaultBranch}`;
      } catch {
        // Fall back to letting git use HEAD.
      }
      const branchArgs = ["checkout", "-B", session.branch];
      if (startPoint) branchArgs.push(startPoint);
      await wsGit.raw(branchArgs);
      console.warn(
        `[restoreSessionWorkspace] branch ${session.branch} not recoverable for ${sessionId} — `
        + `recreated off ${startPoint ?? "HEAD"}; unpushed commits (if any) were lost`,
      );
    }
    handWorkspaceBackToWorker(session.workspaceDir);
  }

  if (githubAuthManager.authenticated) {
    githubAuthManager.configureGitCredentials(session.workspaceDir);
  }

  await materializeLfsAndChown(session.workspaceDir, session.remoteUrl);

  sessionManager.setDiskTier(sessionId, "hot");
  console.log(
    `[restoreSessionWorkspace] re-materialized workspace for ${sessionId} at ${session.workspaceDir}`,
  );
  return true;
}

export function renameSession(
  sessionManager: SessionManager,
  sessionId: string,
  title: string,
): SessionInfo {
  const trimmed = title.trim();
  if (!trimmed) throw new ServiceError(400, "Session title cannot be empty");
  const renamed = sessionManager.rename(sessionId, trimmed, "user");
  if (!renamed) throw new ServiceError(404, "Session not found");
  return renamed;
}

export function setSessionPinned(
  sessionManager: SessionManager,
  sessionId: string,
  pinned: boolean,
): { session: SessionInfo; sessions: SessionInfo[] } {
  const updated = sessionManager.setPinned(sessionId, pinned ? new Date().toISOString() : null);
  if (!updated) throw new ServiceError(404, "Session not found");
  return { session: updated, sessions: sessionManager.list() };
}

export const DEFAULT_MAX_KEEP_PREVIEW_RUNNING = 1;

export function resolveMaxKeepPreviewRunning(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MAX_KEEP_PREVIEW_RUNNING?.trim();
  if (!raw) return DEFAULT_MAX_KEEP_PREVIEW_RUNNING;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_MAX_KEEP_PREVIEW_RUNNING;
}

export function listActiveReservations(sessionManager: SessionManager): SessionInfo[] {
  return sessionManager.listAll().filter(holdsActiveReservation);
}

export function buildReservationFullMessage(reserved: SessionInfo[], maxReservations: number): string {
  // A cap reduced to zero can still have holders; releasing one frees no usable slot.
  if (maxReservations === 0) {
    return "Always-on previews are disabled on this deployment (capacity 0). Raise MAX_KEEP_PREVIEW_RUNNING to enable one.";
  }
  if (reserved.length === 0) return "Always-on preview capacity is full.";
  const inUse = `${reserved.length} of ${maxReservations} in use`;
  if (reserved.length === 1) {
    return `Always-on preview is reserved by "${reserved[0].title}". Turn it off there to free the only slot (${inUse}).`;
  }
  const titles = reserved.map((s) => `"${s.title}"`).join(", ");
  return `Always-on preview capacity is full (${inUse}). Reserved by ${titles} — turn one off first.`;
}

export function setKeepPreviewRunning(
  sessionManager: SessionManager,
  sessionId: string,
  enabled: boolean,
  activate: (session: SessionInfo) => void,
  maxReservations = resolveMaxKeepPreviewRunning(),
): { session: SessionInfo; sessions: SessionInfo[] } {
  const current = sessionManager.get(sessionId);
  if (!current) throw new ServiceError(404, "Session not found");
  if (current.userArchived || current.archived || current.warm) {
    throw new ServiceError(409, "Only active sessions can keep a preview running");
  }
  if (current.kind === "sandbox") {
    throw new ServiceError(409, "Sandbox sessions do not support managed previews");
  }
  if (enabled && !current.workspaceDir) {
    throw new ServiceError(409, "Session has no workspace to preview");
  }

  if (enabled && !current.keepPreviewRunning) {
    const reserved = listActiveReservations(sessionManager);
    if (reserved.length >= maxReservations) {
      throw new ServiceError(409, buildReservationFullMessage(reserved, maxReservations));
    }
  }

  const updated = sessionManager.setKeepPreviewRunning(sessionId, enabled);
  if (!updated) throw new ServiceError(404, "Session not found");
  if (enabled) activate(updated);
  return { session: updated, sessions: sessionManager.list() };
}

// The caller supplies agent activity; the browser checks whether attention is needed.
export function setSessionMuted(
  sessionManager: SessionManager,
  sessionId: string,
  muted: boolean,
  agentWorking: boolean,
  now = new Date(),
): { session: SessionInfo; sessions: SessionInfo[] } {
  const current = sessionManager.get(sessionId);
  if (!current) throw new ServiceError(404, "Session not found");
  if (muted && agentWorking) {
    throw new ServiceError(409, "A session whose agent is working cannot be muted");
  }

  // setMuted returns null for an unchanged row as well as a missing one.
  const updated = sessionManager.setMuted(sessionId, muted ? now.toISOString() : null) ?? current;
  return { session: updated, sessions: sessionManager.list() };
}

export function reorderSessionPins(
  sessionManager: SessionManager,
  remoteUrl: string,
  ids: string[],
): { sessions: SessionInfo[] } {
  validateString(remoteUrl, "remoteUrl");
  validateStringArray(ids, "ids");
  return { sessions: sessionManager.reorderPins(remoteUrl, ids) };
}

export async function archiveSession(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  getBareCacheDir: (url: string) => string,
  sessionId: string,
  pruneVolumes?: (sessionId: string) => Promise<void>,
  containerManager?: { destroy(sessionId: string): Promise<void> } | null,
  removeSessionLogs?: (sessionId: string) => void,
  inProgress = new Set<string>(),
): Promise<{ sessions: SessionInfo[] }> {
  inProgress.add(sessionId);
  const session = sessionManager.get(sessionId);

  // Ops children are independent fixes from separate incidents; keep them alive.
  if (session?.kind !== "ops") {
    for (const child of sessionManager.findChildren(sessionId)) {
      if (inProgress.has(child.id)) continue;
      await archiveSession(
        sessionManager,
        runnerRegistry,
        getBareCacheDir,
        child.id,
        pruneVolumes,
        containerManager,
        removeSessionLogs,
        inProgress,
      );
    }
  }

  const runner = runnerRegistry.get(sessionId);
  const runnerWasAlive = runner !== undefined;
  if (runner && "removeVolumesOnDispose" in runner) {
    (runner as { removeVolumesOnDispose: boolean }).removeVolumesOnDispose = true;
  }

  runnerRegistry.dispose(sessionId, { force: true });

  // Release the container's bind mount before removing the workspace directory.
  if (containerManager) {
    try {
      await containerManager.destroy(sessionId);
    } catch (err) {
      console.warn(`[server] Failed to destroy container for ${sessionId}:`, String(err));
    }
  }

  // Without a runner, the dispose hook cannot remove the named volumes.
  if (!runnerWasAlive && pruneVolumes) {
    await pruneVolumes(sessionId);
  }

  // Preserve local-only workspaces: they have no remote recovery source.
  if (session?.remoteUrl && session?.workspaceDir) {
    const { removed, failed } = await reclaimRegenerableSessionDirs(session.workspaceDir);
    if (removed.length > 0) {
      console.log("[server] Removed session dirs:", removed.join(", "));
    }
    for (const f of failed) {
      console.warn(`[server] Session dir cleanup failed (${f.dir}):`, f.message);
    }
  }

  removeSessionLogs?.(sessionId);

  sessionManager.archive(sessionId);

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

// Sidebar visibility handles excess merged sessions; this does not archive them.
export async function markMergedAndPruneExcess(
  sessionManager: SessionManager,
  _runnerRegistry: SessionRunnerRegistry,
  getBareCacheDir: (url: string) => string,
  sessionId: string,
  _pruneVolumes?: (sessionId: string) => Promise<void>,
  createRepoGit?: (dir: string) => RepoGit,
  githubAuthManager?: GitHubAuthManager,
  _containerManager?: { destroy(sessionId: string): Promise<void> } | null,
): Promise<{ sessions: SessionInfo[] }> {
  sessionManager.markMerged(sessionId);

  const session = sessionManager.get(sessionId);
  if (!session?.remoteUrl) {
    return { sessions: sessionManager.list() };
  }

  if (createRepoGit && session.branch) {
    try {
      const cacheDir = getBareCacheDir(session.remoteUrl);
      const cacheGit = createRepoGit(cacheDir);
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

  return { sessions: sessionManager.list() };
}

export function deleteSession(
  sessionManager: SessionManager,
  sessionId: string,
  chatHistoryManager?: ChatHistoryManager,
  usageManager?: UsageManager,
  removeSessionLogs?: (sessionId: string) => void,
  presentStore?: { deleteSession: (sessionId: string) => void },
): boolean {
  const deleted = sessionManager.delete(sessionId);
  if (deleted) {
    chatHistoryManager?.delete(sessionId);
    usageManager?.delete(sessionId);
    removeSessionLogs?.(sessionId);
    presentStore?.deleteSession(sessionId);
  }
  return deleted;
}
