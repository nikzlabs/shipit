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
import type { SessionInfo, AgentId } from "../../shared/types.js";
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

// ---- Agent-spawned child sessions (docs/117) ----

/** Default per-parent quota for active spawned child sessions. */
export const DEFAULT_MAX_ACTIVE_SPAWNED_SESSIONS = 16;

/** Default per-turn quota for newly-spawned child sessions. */
export const DEFAULT_MAX_SPAWNED_SESSIONS_PER_TURN = 4;

/**
 * Tiny regex-style validation reused from `forkSession`. Rejects anything
 * that's not a sane git ref. Keep in sync with `forkSession`.
 */
function assertValidBranchName(name: string): void {
  if (/[\s~^:?*[\\]/.test(name) || name.includes("..")) {
    throw new ServiceError(400, "Invalid branch name");
  }
}

export interface SpawnChildSessionOptions {
  /** The required initial user prompt that the spawned session's agent runs. */
  prompt: string;
  /** Session title. Defaults to a slug derived from `prompt`. */
  title?: string;
  /** Child branch name. Defaults to a generated prefix (`shipit/<slug>`). */
  branch?: string;
  /**
   * Git ref to branch off. Defaults to the parent's current HEAD via
   * `git rev-parse HEAD`. When provided, this is passed verbatim to
   * `git checkout -b <child-branch> <base>` in the child's workspace, so
   * any value `git` accepts there is allowed (commit hash, `origin/main`,
   * a tag, etc.).
   */
  base?: string;
  /** Optional agent id override. Defaults to the parent's selected agent. */
  agent?: AgentId;
  /** Optional model override. Defaults to the parent's selected model. */
  model?: string;
  /**
   * Free-form id of the parent turn that triggered the spawn. Persisted as
   * `spawnedByTurn` so `shipit session list` can sort "this turn first"
   * without walking chat history.
   */
  spawnedByTurn?: string;
  /**
   * Per-turn cap. Default {@link DEFAULT_MAX_SPAWNED_SESSIONS_PER_TURN}.
   * Counted by matching `spawnedByTurn` on the parent's existing children.
   * Skipped when `spawnedByTurn` is undefined (no turn id ⇒ nothing to
   * count, but the per-parent cap still applies).
   */
  maxSpawnedSessionsPerTurn?: number;
  /**
   * Per-parent cap on active (non-archived) spawned children. Default
   * {@link DEFAULT_MAX_ACTIVE_SPAWNED_SESSIONS}.
   */
  maxActiveSpawnedSessions?: number;
}

export interface SpawnChildSessionResult {
  /** The newly-created child session. */
  session: SessionInfo;
  /** Convenience field for the CLI shim's text output. */
  sessionId: string;
  /** The child's branch name (generated or user-supplied). */
  branch: string;
  /** Updated session list (for SSE broadcast on the parent's side). */
  sessions: SessionInfo[];
}

/**
 * Spawn a sibling session under `parentSessionId`. The new session shares
 * the parent's repo (or local-only fallback) but gets its own clone, branch,
 * chat history, and runner — exactly like a session created from the UI.
 *
 * The agent never reaches this function directly; the call chain is:
 *   `shipit session create` (shim)
 *   → worker `/agent-ops/session/create`
 *   → orchestrator `POST /api/sessions/:parentId/spawn`
 *   → `spawnChildSession`.
 *
 * Quotas are enforced fail-closed (the orchestrator returns 429 / ServiceError
 * before any disk work happens). The first prompt is enqueued on the child's
 * runner via `sendSystemMessage` so it kicks off the agent the moment the
 * runner is ready — matching the home-screen "send a message" behaviour
 * without needing a WS to be attached.
 */
export async function spawnChildSession(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  createRepoGit: (dir: string) => RepoGit,
  getBareCacheDir: (repoUrl: string) => string,
  sessionsRoot: string,
  githubAuthManager: { authenticated: boolean; configureGitCredentials: (dir: string) => void },
  parentSessionId: string,
  opts: SpawnChildSessionOptions,
  defaultAgentId: AgentId,
): Promise<SpawnChildSessionResult> {
  const trimmedPrompt = opts.prompt?.trim();
  if (!trimmedPrompt) {
    throw new ServiceError(400, "prompt is required");
  }
  if (trimmedPrompt.length > 50_000) {
    throw new ServiceError(400, "prompt exceeds 50,000 characters");
  }

  const parent = sessionManager.get(parentSessionId);
  if (!parent) throw new ServiceError(404, "Parent session not found");
  if (parent.archived) throw new ServiceError(400, "Parent session is archived");
  if (!parent.workspaceDir) {
    throw new ServiceError(400, "Parent session has no workspace");
  }

  // Quota: per-parent cap on active spawned children. Fail-closed.
  const maxActive = opts.maxActiveSpawnedSessions ?? DEFAULT_MAX_ACTIVE_SPAWNED_SESSIONS;
  const existingChildren = sessionManager.findChildren(parentSessionId);
  if (existingChildren.length >= maxActive) {
    throw new ServiceError(
      429,
      `This session already has ${existingChildren.length} spawned children (max ${maxActive}). Archive one before spawning another.`,
    );
  }

  // Quota: per-turn cap. Skipped when no turn id is supplied; the per-parent
  // cap still bounds total fanout.
  if (opts.spawnedByTurn) {
    const maxPerTurn = opts.maxSpawnedSessionsPerTurn ?? DEFAULT_MAX_SPAWNED_SESSIONS_PER_TURN;
    const inThisTurn = existingChildren.filter((c) => c.spawnedByTurn === opts.spawnedByTurn).length;
    if (inThisTurn >= maxPerTurn) {
      throw new ServiceError(
        429,
        `Per-turn spawn limit reached (${maxPerTurn}). Wait for the current turn to end before spawning more sessions.`,
      );
    }
  }

  // Validate and compute branch + title up front so we fail fast before disk work.
  const branchName = opts.branch?.trim() || generateBranchPrefix();
  assertValidBranchName(branchName);
  const title = opts.title?.trim() || trimmedPrompt.slice(0, 60) || "Spawned session";

  // Compute the child's session dir.
  const crypto = await import("node:crypto");
  const newSessionId = crypto.randomUUID();
  const newSessionDir = path.join(sessionsRoot, newSessionId);
  const newWorkspaceDir = path.join(newSessionDir, "workspace");
  await fs.mkdir(newSessionDir, { recursive: true });

  // Resolve the branch start point. When the caller omits `--base`, we use the
  // parent's current HEAD so the child sees the parent's *committed* state.
  // Uncommitted/unstaged work in the parent's working tree is intentionally
  // not visible — the child has its own clone.
  let startPoint = opts.base?.trim();
  if (!startPoint) {
    try {
      const parentHead = await simpleGit(parent.workspaceDir).revparse(["HEAD"]);
      startPoint = parentHead.trim();
    } catch {
      // Empty repo or detached HEAD with no commits — let `git checkout -b`
      // fall back to the current branch tip.
      startPoint = undefined;
    }
  }

  // Clone path mirrors `forkSession`: bare-cache → workspace when the parent
  // has a remote; local clone of the parent's session dir otherwise.
  if (parent.remoteUrl) {
    const cacheDir = getBareCacheDir(parent.remoteUrl);
    const cacheGit = createRepoGit(cacheDir);
    try {
      await cacheGit.fetchCache();
    } catch (err) {
      // Non-fatal: a stale bare cache should not block spawn. The branch is
      // cut from `startPoint`, which we resolved against the parent's
      // workspace clone (or `git checkout -b` falls back to current HEAD).
      console.warn("[spawn-child] fetchCache failed (non-fatal):", String(err));
    }
    await cacheGit.cloneFromCache(newWorkspaceDir, parent.remoteUrl);
  } else {
    // Local-repo fallback (used by integration tests that don't set up a remote).
    await simpleGit().raw(["clone", "--local", parent.workspaceDir, newWorkspaceDir]);
    await simpleGit(newWorkspaceDir).raw(["config", "gc.auto", "0"]);
  }

  // Cut the child's branch off `startPoint` (or HEAD when undefined).
  const branchArgs = ["checkout", "-b", branchName];
  if (startPoint) branchArgs.push(startPoint);
  try {
    await simpleGit(newWorkspaceDir).raw(branchArgs);
  } catch (err) {
    // Best-effort cleanup; the next garbage sweep will reclaim the empty dir.
    await fs.rm(newSessionDir, { recursive: true, force: true }).catch(() => {});
    throw new ServiceError(400, `Failed to create branch '${branchName}': ${String(err)}`);
  }

  if (githubAuthManager.authenticated) {
    githubAuthManager.configureGitCredentials(newWorkspaceDir);
  }

  // Persist the session row + parent linkage + model. We deliberately do NOT
  // mark the session warm — it's an explicit, user-visible session from the
  // moment it appears in the sidebar.
  sessionManager.track(newSessionId, title, newWorkspaceDir);
  sessionManager.setBranch(newSessionId, branchName);
  // Branch is already a deliberate name (either user-supplied or a generated
  // prefix) — we don't need the warm-session "rename on first message" dance.
  sessionManager.setBranchRenamed(newSessionId, true);
  if (parent.remoteUrl) {
    sessionManager.setRemoteUrl(newSessionId, parent.remoteUrl);
  }
  sessionManager.setParentSession(newSessionId, parentSessionId, opts.spawnedByTurn);
  const modelToSet = opts.model ?? parent.model;
  if (modelToSet) {
    sessionManager.setModel(newSessionId, modelToSet);
  }

  const child = sessionManager.get(newSessionId);
  if (!child) throw new ServiceError(500, "Failed to read back spawned child session");

  // Enqueue the first prompt. `getOrCreate` on the runner registry creates a
  // container-backed runner (in production) or a SessionRunner (in tests);
  // `sendSystemMessage` then either starts the turn directly (when
  // SystemTurnDeps are wired) or enqueues for the next agent start.
  //
  // We don't store the parent's agent id on `SessionInfo` (only the model is
  // persisted). For v1, children inherit `defaultAgentId` unless the caller
  // passes an explicit `--agent`. The parent agent can specify
  // `opts.agent` to override; otherwise the orchestrator's configured
  // default is used. (A future iteration could carry the parent's runner
  // agent id through.)
  const childAgentId: AgentId = opts.agent ?? defaultAgentId;
  const runner = runnerRegistry.getOrCreate(newSessionId, newWorkspaceDir, childAgentId);
  runner.sendSystemMessage(trimmedPrompt);

  console.log(
    `[spawn-child] Spawned session ${newSessionId} under parent ${parentSessionId}: branch=${branchName} title="${title}"`,
  );

  return {
    session: child,
    sessionId: child.id,
    branch: branchName,
    sessions: sessionManager.list(),
  };
}

// ---- Reads scoped by parent (docs/117) ----

/**
 * Snapshot of a single child session for `shipit session view`. Strictly a
 * read-only projection — the shim cannot mutate the child through this shape.
 */
export interface ChildSessionView {
  id: string;
  title: string;
  branch?: string;
  status: "running" | "idle" | "error";
  queueLength: number;
  parentSessionId: string;
  spawnedAt: string;
  spawnedByTurn?: string;
  prUrl?: string;
  /** Most recent assistant message text. Undefined when the child has not produced one yet. */
  latestAssistantMessage?: string;
}

/**
 * List the children spawned under `parentSessionId`. Sorted "this turn first"
 * if `currentTurn` is provided; otherwise most-recently-used first.
 */
export function listSpawnedChildren(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  parentSessionId: string,
  currentTurn?: string,
): ChildSessionView[] {
  const children = sessionManager.findChildren(parentSessionId);
  const views = children.map((c) => buildChildView(c, runnerRegistry));
  if (currentTurn) {
    return views.sort((a, b) => {
      const aIn = a.spawnedByTurn === currentTurn ? 0 : 1;
      const bIn = b.spawnedByTurn === currentTurn ? 0 : 1;
      if (aIn !== bIn) return aIn - bIn;
      return b.spawnedAt.localeCompare(a.spawnedAt);
    });
  }
  return views;
}

/**
 * Look up a single child session and verify it's a descendant of `parentSessionId`.
 * Throws 404 (`ServiceError`) when the id doesn't exist *or* when it isn't a
 * direct child of the supplied parent — the orchestrator never tells the shim
 * "wrong parent" because cross-tenancy leakage is the threat that motivates
 * this whole boundary in the first place.
 */
export function getSpawnedChild(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  parentSessionId: string,
  childSessionId: string,
): ChildSessionView {
  const child = sessionManager.get(childSessionId);
  if (child?.parentSessionId !== parentSessionId) {
    throw new ServiceError(404, "Spawned session not found");
  }
  return buildChildView(child, runnerRegistry);
}

function buildChildView(
  child: SessionInfo,
  runnerRegistry: SessionRunnerRegistry,
): ChildSessionView {
  const runner = runnerRegistry.get(child.id);
  const view: ChildSessionView = {
    id: child.id,
    title: child.title,
    status: runner?.running ? "running" : "idle",
    queueLength: runner?.queueLength ?? 0,
    parentSessionId: child.parentSessionId ?? "",
    spawnedAt: child.createdAt,
  };
  if (child.branch) view.branch = child.branch;
  if (child.spawnedByTurn) view.spawnedByTurn = child.spawnedByTurn;
  // `latestAssistantMessage` is intentionally omitted in v1: pulling it from
  // chat history would require importing ChatHistoryManager here and tracking
  // a "most recent assistant text" projection. The shim's plain-text rendering
  // degrades gracefully (the field just doesn't print).
  return view;
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
