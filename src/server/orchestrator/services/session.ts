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

// Re-exports so external consumers continue to resolve these from "./session.js".
export { forkSession, mergeSession } from "./session-fork-merge.js";
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

/**
 * Get chat messages for a session (read-only, no activation side effects).
 *
 * This is the browser-facing read, so it is where the docs/244 lazy-body
 * projection is applied: heavy tool outputs, file bodies behind a `+N -M`
 * summary, and base64 images are replaced by metadata plus a fetch URL. The
 * projection deliberately does NOT live in `ChatHistoryManager.load` — that has
 * internal consumers (rollback handlers, agent env, PR-description building)
 * which need the real content, and `fromRow` feeds read-modify-write paths that
 * would persist the truncation.
 */
export function getChatHistory(
  chatHistoryManager: { load: (sessionId: string) => unknown[] },
  sessionId: string,
) {
  return projectMessagesForWire(sessionId, chatHistoryManager.load(sessionId) as PersistedMessage[]);
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

/**
 * docs/231 — pull Git LFS content into a freshly re-cloned workspace, then hand
 * the (root-written) files back to the worker uid.
 *
 * The restore paths below re-materialize the worktree with `git checkout`, which
 * writes LFS **pointer stubs**: the orchestrator deliberately runs with the
 * smudge filter disabled (see `git-lfs.ts` for why turning it on would break
 * `clone --local` outright), so content is always restored explicitly.
 *
 * These paths have no SSE broadcaster in scope, so a warning goes to the log
 * rather than a toast — `materializeLfsWithWarning` already logs the failure
 * detail; this sink adds the session's repo for correlation. Non-LFS repos exit
 * on a single cheap grep, so this is safe to call unconditionally.
 */
async function materializeLfsAndChown(workspaceDir: string, repoUrl: string | undefined): Promise<void> {
  const result = await materializeLfsWithWarning(workspaceDir, repoUrl ?? workspaceDir, (message) =>
    console.warn(`[session] ${message}`),
  );
  // Only re-chown when the pull actually wrote files — a non-LFS repo shouldn't
  // pay for a full-tree ownership walk on every restore.
  //
  // docs/270 — the object-aware handback, not a plain recursive chown. A session
  // clone's `.git/objects` are HARDLINKS into the shared bare cache (`git clone
  // --local`), and an inode has one owner across every link, so chowning object
  // files hands this session rewrite rights over content every other clone of
  // the repo reads. Invisible while all sessions shared one uid.
  if (result.status === "materialized") handWorkspaceBackToWorker(workspaceDir);
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
  if (!session || (session.diskTier !== "evicted" && !session.userArchived)) {
    throw new ServiceError(404, "Session not found or not restorable");
  }

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

    // An evicted session may have been demoted long ago; its bare cache can be
    // far behind the remote (e.g. the PR merged and `main` advanced). Force a
    // fresh fetch (ttl 0, bypassing the freshness marker) so the restored clone
    // and its new branch base reflect current upstream. A fetch failure is not
    // fatal — fall back to whatever the cache already has rather than aborting
    // the restore.
    try {
      await cacheGit.fetchCache(0);
    } catch (fetchErr) {
      console.warn(
        `[unarchiveSession] fetchCache failed for ${session.remoteUrl}; restoring from stale cache:`,
        fetchErr,
      );
    }

    // Clone from bare cache into session dir. Retry only the clone (lock
    // contention) — the fetch above already ran once and is non-fatal.
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
    await safeSimpleGit(session.workspaceDir).raw(branchArgs);

    // Configure credentials
    if (githubAuthManager.authenticated) {
      githubAuthManager.configureGitCredentials(session.workspaceDir);
    }

    // docs/231 — the `checkout -b` above wrote LFS pointer stubs (the
    // orchestrator's smudge filter is off by design), so restore real content.
    // Runs after the credential helper is in place — a private repo's LFS
    // endpoint needs it — and re-chowns because the pull writes as root.
    await materializeLfsAndChown(session.workspaceDir, session.remoteUrl);

    sessionManager.setBranch(sessionId, newBranch);
  }

  sessionManager.unarchive(sessionId);
  const updated = sessionManager.get(sessionId);
  if (!updated) throw new ServiceError(404, "Session not found");
  return { session: updated, sessions: sessionManager.list() };
}

/**
 * docs/161 / planning#181 — re-materialize a LIVE (non-user-archived) session's
 * workspace that is missing on disk, so activating it boots a container against
 * a real bind-mount source instead of 404-looping.
 *
 * A workspace can be legitimately absent for a non-archived session: it was
 * disk-evicted (`diskTier === "evicted"`, the docs/161 reclaim) or lost to a
 * real fs failure. Unlike {@link unarchiveSession} — which restores a
 * USER-archived session and deliberately cuts a FRESH branch off origin/main —
 * this PRESERVES the session's committed branch: the user is returning to live
 * work, so the branch, its pushed commits, and its PR association must survive.
 * Only uncommitted working-tree edits made since the last auto-commit are
 * unrecoverable, and the eviction path auto-commits + pushes before wiping, so
 * in the common case nothing is lost.
 *
 * Cheap to call on every activation: returns `false` immediately when the
 * workspace is already present and the session is not evicted. Throws
 * `ServiceError` when recovery is genuinely impossible (no remote / no bare
 * cache to clone from) so the caller can surface a terminal "workspace lost"
 * state rather than retry-looping a doomed container create.
 *
 * Returns `true` when it (re-)materialized the workspace from the bare cache.
 *
 * Concurrency-safe: a session can be activated from two places at once — the
 * fire-and-forget `void activateSession` on WS connect AND an awaited
 * `activateSession` from the first send-message. Both would otherwise race
 * (`rm -rf` clobbering the other's in-flight clone), so calls for the same
 * session are de-duped onto a single in-flight promise.
 */
const inFlightRestores = new Map<string, Promise<boolean>>();

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

  // Standalone / template sessions (no remote) can't be re-cloned. If such a
  // session's checkout exists there's nothing to do; if it's gone, it's
  // genuinely unrecoverable — surface a terminal error rather than boot a
  // container against a missing dir.
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

  // Healthy + present → nothing to do (the overwhelmingly common path).
  if (workspacePresent && !evicted) return false;
  // Evicted bookkeeping but the checkout somehow survived (a failed eviction
  // `rm`): just flip the tier back — booting the runner re-installs deps.
  if (workspacePresent && evicted) {
    sessionManager.setDiskTier(sessionId, "hot");
    return false;
  }

  // Workspace is genuinely missing — re-clone from the bare cache, preserving
  // the session's branch. Mirrors `unarchiveSession`'s clone block.
  const cacheDir = getBareCacheDir(session.remoteUrl);
  const { git: cacheGit, recovered } = await ensureBareCache(cacheDir, session.remoteUrl, createRepoGit);
  if (recovered) {
    repoStore.add(session.remoteUrl);
    repoStore.setReady(session.remoteUrl);
  }
  if (githubAuthManager.authenticated) {
    await cacheGit.setRemoteUrl(session.remoteUrl);
  }

  // Clear any stale remnant (partial clone from a previous failed attempt).
  await fs.rm(session.workspaceDir, { recursive: true, force: true });

  // Refresh the cache (ttl 0) so the session's pushed branch is present locally
  // before the `--local` clone. Non-fatal — fall back to whatever the cache has.
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

  // Check out the session's committed branch (preserving its work). The branch
  // is in the `--local` clone iff it was pushed — the eviction durability gate
  // pushes before wiping, so the common path finds it. If it's genuinely
  // unrecoverable (never pushed, cache too stale), (re-)create it off the
  // default branch so the session is at least usable rather than dead.
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
    // `git checkout` rewrote the worktree as the root orchestrator; hand it back
    // to the worker uid so the non-root agent can edit tracked files (docs/150 §7).
    // docs/270 — object-aware, for the hardlink reason above.
    handWorkspaceBackToWorker(session.workspaceDir);
  }

  if (githubAuthManager.authenticated) {
    githubAuthManager.configureGitCredentials(session.workspaceDir);
  }

  // docs/231 — same as the unarchive path: the `checkout` above re-materialized
  // the worktree as LFS pointer stubs, so pull the real content back.
  await materializeLfsAndChown(session.workspaceDir, session.remoteUrl);

  sessionManager.setDiskTier(sessionId, "hot");
  console.log(
    `[restoreSessionWorkspace] re-materialized workspace for ${sessionId} at ${session.workspaceDir}`,
  );
  return true;
}

// ---- Mutation operations ----

/**
 * Rename a session from the sidebar. Returns the updated session or throws
 * ServiceError.
 *
 * docs/250 — records the title as user-set, which locks it: from here on neither
 * the agent's `shipit session rename` nor the AI namer will overwrite it
 * (requirement 4). This is the ONLY writer that passes `"user"`.
 */
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

/**
 * docs/110 — pin or unpin a session. Pinning makes it persistent: it sticks to
 * the top of its repo group, stays exempt from the merged sidebar view cap, and
 * is immune to automatic disk-tier reclamation. Returns the updated session plus
 * the refreshed sidebar list so the caller can broadcast `session_list`.
 */
export function setSessionPinned(
  sessionManager: SessionManager,
  sessionId: string,
  pinned: boolean,
): { session: SessionInfo; sessions: SessionInfo[] } {
  const updated = sessionManager.setPinned(sessionId, pinned ? new Date().toISOString() : null);
  if (!updated) throw new ServiceError(404, "Session not found");
  return { session: updated, sessions: sessionManager.list() };
}

/** Default deployment-wide reservation capacity (docs/241). */
export const DEFAULT_MAX_KEEP_PREVIEW_RUNNING = 1;

/** Resolve the operator cap. Invalid/negative values fail safe to the default. */
export function resolveMaxKeepPreviewRunning(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MAX_KEEP_PREVIEW_RUNNING?.trim();
  if (!raw) return DEFAULT_MAX_KEEP_PREVIEW_RUNNING;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_MAX_KEEP_PREVIEW_RUNNING;
}

/**
 * docs/241 — the sessions that actually hold a reservation, and so the ones the
 * cap admits against.
 *
 * An archived session is excluded even when its row still carries the flag.
 * `SessionManager.archive` clears it now, but rows archived before that fix
 * exist in deployed databases, and such a row is unreachable: `listAll()`
 * returns archived sessions, while the toggle that would release one is only
 * rendered on a non-archived sidebar row. Counting it made the deployment's
 * only slot permanently unavailable. Excluding it here heals those rows without
 * a migration — the same predicate answers "who holds the slot".
 */
export function listActiveReservations(sessionManager: SessionManager): SessionInfo[] {
  return sessionManager.listAll().filter(holdsActiveReservation);
}

/**
 * docs/241 — the refusal message, which names the session(s) holding the slots.
 *
 * A bare "capacity is full (1/1)" states the count the user already inferred
 * from the refusal and withholds the one fact they need to act. Titles come
 * from the same rows the cap counted, so the message cannot name a session the
 * user has no way to reach.
 *
 * A cap of 0 (the operator disabling the feature) is about the cap rather than
 * any holder, and a raised cap can have several holders, so the sentence is
 * built rather than templated. The cap is checked FIRST: lowering the cap to 0
 * does not release reservations already granted, so `reserved` can be non-empty
 * there — and the holder-shaped sentence would then promise that turning one
 * off frees a slot, which at capacity 0 it never does.
 */
export function buildReservationFullMessage(reserved: SessionInfo[], maxReservations: number): string {
  if (maxReservations === 0) {
    return "Always-on previews are disabled on this deployment (capacity 0). Raise MAX_KEEP_PREVIEW_RUNNING to enable one.";
  }
  // Unreachable from the admission check (0 >= a positive cap is false), but
  // the function stays total for any other caller.
  if (reserved.length === 0) return "Always-on preview capacity is full.";
  const inUse = `${reserved.length} of ${maxReservations} in use`;
  if (reserved.length === 1) {
    return `Always-on preview is reserved by "${reserved[0].title}". Turn it off there to free the only slot (${inUse}).`;
  }
  const titles = reserved.map((s) => `"${s.title}"`).join(", ");
  return `Always-on preview capacity is full (${inUse}). Reserved by ${titles} — turn one off first.`;
}

/**
 * docs/241 — reserve/release a live preview slot. Admission is checked before
 * mutation. Enabling activates through the ordinary runner factory, whose
 * onRunnerCreated hook owns install + Compose auto-preview reconciliation.
 */
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

/**
 * docs/110 Phase 2 — reorder a repo's pinned sessions to the order in `ids`.
 * Returns the refreshed sidebar list for the caller to broadcast.
 */
export function reorderSessionPins(
  sessionManager: SessionManager,
  remoteUrl: string,
  ids: string[],
): { sessions: SessionInfo[] } {
  validateString(remoteUrl, "remoteUrl");
  validateStringArray(ids, "ids");
  return { sessions: sessionManager.reorderPins(remoteUrl, ids) };
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
 *
 * Archiving cascades through the session's whole spawn brood — except for an
 * Ops session, which never cascades (see the comment at the cascade loop).
 */
export async function archiveSession(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  getBareCacheDir: (url: string) => string,
  sessionId: string,
  pruneVolumes?: (sessionId: string) => Promise<void>,
  containerManager?: { destroy(sessionId: string): Promise<void> } | null,
  /**
   * docs/192 — drop the session's durable `logs/` dir + in-memory ring. Called
   * unconditionally (unlike the `remoteUrl`-gated workspace rm below): logs are
   * never re-creatable and aren't the user's source, so a local-only session's
   * logs should go too. The disk-janitor `sweepOrphanSessionLogs` is the
   * backstop for paths that don't pass this.
   */
  removeSessionLogs?: (sessionId: string) => void,
  /**
   * Sessions already being archived by this cascade. Guards the recursion
   * against parent-link cycles — a self-parented session (produced live by the
   * spawn-claims-its-own-parent bug this commit also fixes) made the cascade
   * recurse forever ("Maximum call stack size exceeded"), turning a corrupt
   * link into an unarchivable session.
   */
  inProgress = new Set<string>(),
): Promise<{ sessions: SessionInfo[] }> {
  inProgress.add(sessionId);
  const session = sessionManager.get(sessionId);

  // Cascade to children first. A spawned child is an independent session
  // (own workspace, branch, container) but it references the parent via
  // `parent_session_id`; leaving children alive after the parent disappears
  // strands them with a broken breadcrumb. Recursing through `archiveSession`
  // means grandchildren are handled by the same path. Children are otherwise
  // never archived automatically (see `markMergedAndPruneExcess`) — they only
  // go away via explicit action on the child, or this cascade from the parent.
  //
  // EXCEPTION — an Ops session (docs/128) never cascades (docs/162). An Ops
  // session is a per-host cockpit, not the root of a cohort: its children are
  // remediation sessions on the *ShipIt source repo*, carrying their own branch
  // and (usually) an open PR, spawned across unrelated incidents. Archiving the
  // cockpit — routine after an incident, or to recreate it against a new host —
  // is a statement about the cockpit, not about the fixes it started, so the
  // cascade would force-dispose running agents and delete workspaces the
  // operator still needs. The child keeps its `parent_session_id` breadcrumb:
  // the sidebar already renders a child whose root isn't visible at top level
  // (`SessionGroup.tsx` orphan fallback), the merged-view-cap exemption keys off
  // *live* roots so an archived Ops parent stops pinning its brood open, and
  // unarchiving the Ops session re-links the tree as it was. Ops children are
  // reachable and archivable on their own, exactly like any other session.
  if (session?.kind !== "ops") {
    for (const child of sessionManager.findChildren(sessionId)) {
      if (inProgress.has(child.id)) continue; // cycle / already in this cascade
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
  // re-creates it from scratch on restore. Template sessions (no remoteUrl)
  // have no recovery path, so we preserve their workspace dir.
  if (session?.remoteUrl && session?.workspaceDir) {
    // planning#194 — reclaim the checkout AND the regenerable overlay/ upper sibling,
    // preserving durable siblings (uploads/, restored on unarchive). Removing
    // only the checkout orphaned the overlay upper — the bulk of the disk —
    // which the bare cache + unarchive flow rebuilds on the next install.
    const { removed, failed } = await reclaimRegenerableSessionDirs(session.workspaceDir);
    if (removed.length > 0) {
      console.log("[server] Removed session dirs:", removed.join(", "));
    }
    for (const f of failed) {
      console.warn(`[server] Session dir cleanup failed (${f.dir}):`, f.message);
    }
  }

  // Drop the durable log backlog + ring (docs/192) — unconditional, since logs
  // are never re-creatable and unarchive doesn't restore them.
  removeSessionLogs?.(sessionId);

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

/**
 * Mark a session as merged and clean up its remote head branch. Called when a
 * PR merge is detected.
 *
 * Demotion of excess merged sessions out of the sidebar is no longer an
 * archive/disk operation: `SessionManager.list()` derives sidebar visibility
 * from the per-repo top-N merged predicate (`filterVisibleInSidebar`), so
 * older merged sessions drop off the list automatically while their workspace
 * and container stay on disk (hot) until the disk-idle ladder evicts them.
 * This function therefore only marks merged + deletes the remote branch; it no
 * longer force-archives or disposes runners.
 *
 * Deletes the remote head branch (best-effort) for the just-merged session so
 * feature branches don't accumulate on GitHub. Many repos enable "automatically
 * delete head branches" upstream, in which case our delete is a harmless no-op;
 * for repos without that setting, this is the cleanup.
 *
 * `_runnerRegistry`, `_pruneVolumes`, and `_containerManager` are retained in
 * the signature (prefixed unused) so the PR-poller wiring and other callers
 * don't have to change while disk eviction is owned elsewhere.
 */
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
  /** docs/192 — drop the session's durable `logs/` dir + in-memory ring. */
  removeSessionLogs?: (sessionId: string) => void,
  /** docs/093 — drop the session's persisted Present-tab metadata. */
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
