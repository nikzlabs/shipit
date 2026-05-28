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
import { graduateSession, type GraduateSessionDeps } from "./graduate-session.js";
import { ServiceError } from "./types.js";

/** Fork a session into a new clone with its own branch. */
export async function forkSession(
  sessionManager: SessionManager,
  _createRepoGit: (dir: string) => RepoGit,
  _getBareCacheDir: (repoUrl: string) => string,
  sessionsRoot: string,
  githubAuthManager: { authenticated: boolean; configureGitCredentials: (dir: string) => void },
  _threadManager: { init: (sessionId: string) => void },
  activeSessionId: string,
  activeSessionDir: string,
  branchName: string,
  startPoint: string | undefined,
  title: string | undefined,
  graduationDeps: GraduateSessionDeps,
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

  // Clone from the active session worktree (not the bare cache). The chat
  // history's `startPoint` SHA is from an auto-commit in this session — it
  // is guaranteed to exist here, but may be missing from the bare cache
  // (commit not yet auto-pushed, or pruned after the PR branch was deleted).
  // --local hardlinks objects on the same filesystem, so disk cost matches
  // the old cache-clone path.
  await simpleGit().raw(["clone", "--local", activeSessionDir, newWorkspaceDir]);
  const newGit = simpleGit(newWorkspaceDir);
  // Disable auto-gc so hardlinks aren't broken in either clone.
  await newGit.raw(["config", "gc.auto", "0"]);
  // Reset origin to the real remote (clone --local sets it to activeSessionDir).
  if (activeSession?.remoteUrl) {
    await newGit.raw(["remote", "set-url", "origin", activeSession.remoteUrl]);
  }
  if (githubAuthManager.authenticated) {
    githubAuthManager.configureGitCredentials(newWorkspaceDir);
  }
  // Refresh remote-tracking refs against the real upstream. After clone
  // --local, refs/remotes/origin/* mirror the active session's local
  // branches, so PR-diff bases (e.g. origin/main) start out pointing at
  // the active session's local view rather than real origin — that's
  // what produces the "+1657 -94" diff inflation on a fresh fork until
  // the next auto-push fetch normalizes them.
  if (activeSession?.remoteUrl) {
    try {
      await newGit.raw(["fetch", "origin", "--prune"]);
    } catch (err) {
      console.warn("[git] fork: fetch origin failed (non-fatal):", String(err));
    }
  }
  const branchArgs = ["checkout", "-b", trimmed];
  if (startPoint) branchArgs.push(startPoint);
  await newGit.raw(branchArgs);

  // Fork-specific workspace identity: insert the row, pin branch + remote.
  // graduateSession is called after — it needs `remoteUrl` already set so
  // `repoStore.touch` can fire.
  const resolvedTitle = title?.trim() || `${activeSession?.title ?? "Session"} (${trimmed})`;
  sessionManager.track(newSessionId, resolvedTitle, newWorkspaceDir);
  sessionManager.setBranch(newSessionId, trimmed);
  if (activeSession?.remoteUrl) {
    sessionManager.setRemoteUrl(newSessionId, activeSession.remoteUrl);
  }

  // graduate-session.ts owns the warm → active transition (docs/156).
  // Do not inline setWarm / setBranchRenamed / scheduleSessionNaming /
  // repoStore.touch / sseBroadcast("session_list") here.
  //
  // Both explicit fields set: AI naming is suppressed (user chose the title
  // and branch). `skipBranchRename: true` is belt-and-braces — the explicit
  // gate already short-circuits naming, but a future change to the naming
  // policy must not be able to silently rewrite a fork branch the user
  // chose.
  graduateSession(graduationDeps, {
    sessionId: newSessionId,
    userText: "",
    agentId: activeSession?.agentId ?? "claude",
    explicitTitle: resolvedTitle,
    explicitBranch: trimmed,
    skipBranchRename: true,
  });

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
