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
import { reclaimRegenerableSessionDirs, reclaimBlockedSessionCaches } from "../disk-utils.js";
import {
  ensureCheckoutDurable,
  pathState,
  type CheckoutDurability,
} from "../checkout-durability.js";
import { autoCommitAllowed } from "./auto-commit-gate.js";
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

/**
 * Restoring replaces the checkout with a fresh clone on a new branch, which is fine
 * when everything is on the remote and destroys the session's work when it is not —
 * and "not" is exactly the state archiving keeps a checkout for.
 *
 * So: push what can be pushed, and answer whether the clone may be replaced. A `false`
 * sends the caller down the in-place path instead, which keeps the existing checkout
 * and every commit in it. Refusing the restore outright is not an option — it would
 * leave a session that can be neither opened nor cleaned up.
 */
async function checkoutIsReplaceable(
  session: SessionInfo,
  createGitManager?: (dir: string) => GitManager,
): Promise<boolean> {
  const dir = session.workspaceDir;
  if (!dir || !createGitManager || !autoCommitAllowed(session)) return true;
  const state = await checkoutState(dir);
  if (state === "absent" || state === "no-repository") return true;
  if (state === "unknown") {
    console.warn(`[unarchiveSession] ${session.id}: workspace unreadable; restoring in place`);
    return false;
  }
  try {
    const durability = await withTimeout(
      ensureCheckoutDurable(createGitManager(dir), "Auto-commit before restoring the session"),
      DURABILITY_TIMEOUT_MS,
    );
    if (durability.state === "durable") return true;
    console.warn(
      `[unarchiveSession] ${session.id}: ${session.branch ?? "its branch"} is not on the remote `
      + `(${durability.state}); restoring in place so those commits survive`,
    );
    return false;
  } catch (err) {
    console.warn(
      `[unarchiveSession] ${session.id}: could not check the old checkout before replacing it:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/**
 * Restore onto the checkout that is already there, and touch nothing in git.
 *
 * The reason this path exists is that the repository holds state nothing else does, so
 * "helpfully" starting a new branch here is the one move guaranteed to damage it:
 * `git checkout -b` clears `MERGE_HEAD` and the rest of the branch state, which turns
 * an unfinished merge into an unabortable tree of conflicted files, and a branch
 * created mid-rebase abandons the rebase. The session opens exactly as it was left;
 * finishing or discarding that work is the user's call, not ours.
 */
async function restoreInPlace(
  workspaceDir: string,
  githubAuthManager: GitHubAuthManager,
  remoteUrl: string,
): Promise<void> {
  if (githubAuthManager.authenticated) {
    githubAuthManager.configureGitCredentials(workspaceDir);
  }
  await materializeLfsAndChown(workspaceDir, remoteUrl);
}

export async function unarchiveSession(
  sessionManager: SessionManager,
  createRepoGit: (dir: string) => RepoGit,
  getBareCacheDir: (url: string) => string,
  githubAuthManager: GitHubAuthManager,
  repoStore: RepoStore,
  sessionId: string,
  prStatusPoller?: UnarchivePrStatusPoller,
  createGitManager?: (dir: string) => GitManager,
): Promise<{ session: SessionInfo; sessions: SessionInfo[] }> {
  const session = sessionManager.get(sessionId);
  if (!session || (session.diskTier !== "evicted" && !session.userArchived)) {
    throw new ServiceError(404, "Session not found or not restorable");
  }

  if (session.remoteUrl && session.workspaceDir) {
    // Ask before touching the bare cache: a checkout holding work that is on no remote
    // is restored where it stands, and re-cloning it would be the deletion archiving
    // just refused to do.
    if (!(await checkoutIsReplaceable(session, createGitManager))) {
      // Unarchive FIRST. A retained checkout sits at tier `light`, which is exactly the
      // tier the eviction pass acts on, and that pass knows about runners, viewers and
      // pins — not about an HTTP restore in flight. `hot` puts it out of reach before
      // any slow work starts; the worst a concurrent pass can then do is drop dep
      // caches, which are not work.
      sessionManager.unarchive(sessionId);
      clearPriorPrState(sessionManager, prStatusPoller, sessionId);
      await restoreInPlace(session.workspaceDir, githubAuthManager, session.remoteUrl);
      const restored = sessionManager.get(sessionId);
      if (!restored) throw new ServiceError(404, "Session not found");
      return { session: restored, sessions: sessionManager.list() };
    }

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

/** Why a user-initiated archive left the session's checkout on disk. */
export interface CheckoutRetained {
  sessionId: string;
  branch?: string;
  message: string;
}

/**
 * "unknown" is not "absent": an I/O or permission error on the workspace says nothing
 * about whether work is in there, and the caller must treat it as protected. Uses the
 * same `pathState` the eviction pass does, for the same reason.
 */
async function checkoutState(
  dir: string,
): Promise<"absent" | "no-repository" | "repository" | "unknown"> {
  const workspace = await pathState(dir);
  if (workspace === "absent") return "absent";
  if (workspace === "unknown") return "unknown";
  const repo = await pathState(path.join(dir, ".git"));
  if (repo === "present") return "repository";
  if (repo === "unknown") return "unknown";
  const entries = await fs.readdir(dir).catch(() => null);
  if (entries === null) return "unknown";
  return entries.length === 0 ? "absent" : "no-repository";
}

/**
 * Archiving and restoring are user actions waiting on an HTTP response, so the git work
 * they do is bounded. Work still running when this expires is not cancelled — git has
 * no cancellation to offer here — but it is bounded in its own right: the checkout is
 * kept either way, so nothing is deleted underneath it, and git's own `index.lock`
 * serializes the only step that writes (a straggler auto-commit fails rather than
 * interleaving with a later one).
 */
const DURABILITY_TIMEOUT_MS = 20_000;

// Bounds the wait without cancelling the git work, which has no cancellation to offer.
// The loser is left with a handler so a later rejection is not unhandled.
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  work.catch(() => undefined);
  return Promise.race([work, expiry]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function retained(session: SessionInfo, message: string): CheckoutRetained {
  return { sessionId: session.id, branch: session.branch, message };
}

const RETAINED_SUFFIX =
  "Restore the session to get them back and push from there; until then ShipIt keeps "
  + "the files rather than deleting work that is on no remote.";

/**
 * Archiving deletes a repo-backed checkout because the bare cache plus the unarchive
 * flow re-create it — but that only recovers what reached the REMOTE. Commits that were
 * never pushed exist nowhere else, which is why the disk janitor's eviction pass refuses
 * to evict on them (`blocked-by-push`). Run the same check here, from the same helper.
 *
 * Returns `undefined` when the checkout may be deleted, or the reason it was kept. The
 * retained checkout stays at disk tier `light`, so the janitor's eviction pass revisits
 * it and reclaims the space on its own once the branch can be pushed.
 *
 * "Cannot be made durable" is read exactly as the eviction pass reads it, with no
 * exception for a tree git refuses to commit. It is tempting to treat uncommittable
 * changes as the user's to lose — but that state is rarely only working-tree changes:
 * an unresolved merge holds `MERGE_HEAD`, whose side of the merge is routinely local
 * commits that pushing the current branch would not save. The safe reading is the
 * simple one, and it is resolvable now: restoring the session hands the checkout back
 * untouched, so the user can finish or discard the work and archive again.
 */
async function retainOrReclaimCheckout(
  session: SessionInfo,
  createGitManager?: (dir: string) => GitManager,
): Promise<CheckoutRetained | undefined> {
  const dir = session.workspaceDir;
  if (!dir || !createGitManager) return undefined;

  // Ops/sandbox sessions are held out of every automatic commit sweep and are never
  // evicted, so archiving is the only path that ever reclaims their disk.
  if (!autoCommitAllowed(session)) return undefined;

  const state = await checkoutState(dir);
  // An already-evicted checkout has nothing to protect, and constructing a GitManager
  // on an absent directory throws.
  if (state === "absent" || state === "no-repository") return undefined;
  if (state === "unknown") {
    console.warn(`[server] archive: keeping the checkout for ${session.id} — its workspace could not be read`);
    return retained(
      session,
      `Session archived, but its files were kept: ShipIt could not read the workspace, so it `
      + `cannot tell whether anything there is unsaved. ${RETAINED_SUFFIX}`,
    );
  }

  let durability: CheckoutDurability;
  try {
    durability = await withTimeout(
      ensureCheckoutDurable(createGitManager(dir), "Auto-commit before archiving"),
      DURABILITY_TIMEOUT_MS,
    );
  } catch (err) {
    // Git could not answer, or took too long to. Deleting on an unreadable answer is
    // what this whole guard exists to prevent, so keep the checkout.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[server] archive: durability check failed for ${session.id}:`, message);
    return retained(
      session,
      "Session archived, but its files were kept: ShipIt could not confirm that its commits "
      + `are on the remote. ${RETAINED_SUFFIX}`,
    );
  }

  if (durability.state === "durable") return undefined;

  const why = durability.state === "blocked-by-dirty"
    ? `it holds changes git refused to commit (${durability.reason.kind})`
    : durability.cause === "detached-head"
      ? "its HEAD is detached, so its commits belong to no branch that could be pushed"
      : `its branch could not be pushed (${durability.message})`;
  console.warn(
    `[server] archive: keeping the checkout for ${session.id} — ${why}. `
    + "Deleting it could destroy work that is on no remote.",
  );
  return retained(
    session,
    durability.state === "blocked-by-dirty"
      ? `Session archived, but its files were kept: it holds changes ShipIt could not commit `
        + `(${durability.reason.kind}), so it cannot tell what is only here. ${RETAINED_SUFFIX}`
      : `Session archived, but its files were kept: ${session.branch ?? "its branch"} has commits `
        + `that are not on the remote. ${RETAINED_SUFFIX}`,
  );
}

export async function archiveSession(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  getBareCacheDir: (url: string) => string,
  sessionId: string,
  pruneVolumes?: (sessionId: string) => Promise<void>,
  containerManager?: { destroy(sessionId: string): Promise<void> } | null,
  removeSessionLogs?: (sessionId: string) => void,
  createGitManager?: (dir: string) => GitManager,
  inProgress = new Set<string>(),
): Promise<{ sessions: SessionInfo[]; checkoutsRetained?: CheckoutRetained[] }> {
  inProgress.add(sessionId);
  const session = sessionManager.get(sessionId);

  // A child that kept its checkout has to reach the caller too: archiving a parent is
  // one user action, and a notice that stops at the recursion is a notice nobody sees.
  const fromChildren: CheckoutRetained[] = [];

  // Ops children are independent fixes from separate incidents; keep them alive.
  if (session?.kind !== "ops") {
    for (const child of sessionManager.findChildren(sessionId)) {
      if (inProgress.has(child.id)) continue;
      const childResult = await archiveSession(
        sessionManager,
        runnerRegistry,
        getBareCacheDir,
        child.id,
        pruneVolumes,
        containerManager,
        removeSessionLogs,
        createGitManager,
        inProgress,
      );
      if (childResult.checkoutsRetained) fromChildren.push(...childResult.checkoutsRetained);
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
  let ownRetained: CheckoutRetained | undefined;
  if (session?.remoteUrl && session?.workspaceDir) {
    ownRetained = await retainOrReclaimCheckout(session, createGitManager);
    if (ownRetained) {
      // Keep only what cannot be regenerated: dependency caches are not work.
      const { removed, message } = await reclaimBlockedSessionCaches(session.workspaceDir);
      if (message) console.warn(`[server] archive: cache reclaim failed for ${sessionId}:`, message);
      if (removed.length > 0) {
        console.log("[server] archive: kept the checkout, reclaimed dep caches:", removed.join(", "));
      }
    } else {
      const { removed, failed } = await reclaimRegenerableSessionDirs(session.workspaceDir);
      if (removed.length > 0) {
        console.log("[server] Removed session dirs:", removed.join(", "));
      }
      for (const f of failed) {
        console.warn(`[server] Session dir cleanup failed (${f.dir}):`, f.message);
      }
    }
  }

  removeSessionLogs?.(sessionId);

  sessionManager.archive(sessionId, { keepCheckout: ownRetained !== undefined });

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

  const checkoutsRetained = [...(ownRetained ? [ownRetained] : []), ...fromChildren];
  return {
    sessions: sessionManager.list(),
    ...(checkoutsRetained.length > 0 ? { checkoutsRetained } : {}),
  };
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
