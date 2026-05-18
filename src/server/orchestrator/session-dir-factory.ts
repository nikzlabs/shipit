import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import type { SessionManager } from "./sessions.js";
import { repoUrlToHash } from "./git-utils.js";

// ---- Session directory creation ----

/** Dependencies for session directory creation. */
export interface SessionDirDeps {
  sessionsRoot: string;
  sessionManager: SessionManager;
}

/**
 * Create a factory function for creating new session directories.
 * The directory is created empty — git worktree setup happens separately.
 */
export function createSessionDirFactory(
  dirDeps: SessionDirDeps,
): (title: string) => Promise<{ appSessionId: string; sessionDir: string; workspaceDir: string }> {
  const { sessionsRoot, sessionManager } = dirDeps;

  return async (
    title: string,
  ): Promise<{ appSessionId: string; sessionDir: string; workspaceDir: string }> => {
    const appSessionId = crypto.randomUUID();
    const sessionDir = path.join(sessionsRoot, appSessionId);
    const workspaceDir = path.join(sessionDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    sessionManager.track(appSessionId, title, workspaceDir);
    console.log("[server] Created session directory:", sessionDir);

    return { appSessionId, sessionDir, workspaceDir };
  };
}

// ---- Bare cache directory ----

/**
 * Create the `getBareCacheDir` helper — returns the bare repo cache path.
 * Lives under {@link stateDir} (defaults to workspaceDir for back-compat;
 * in local mode, set to a directory outside the visible workspace).
 */
export function createBareCacheDirHelper(
  stateDir: string,
): (repoUrl: string) => string {
  const cacheRoot = path.join(stateDir, "repo-cache");
  return (repoUrl: string): string => {
    return path.join(cacheRoot, repoUrlToHash(repoUrl));
  };
}

/**
 * Create the `getDepCacheDir` helper — returns a per-repo dependency cache
 * directory decoupled from the bare cache. Lives at {stateDir}/dep-cache/{hash}.
 */
export function createDepCacheDirHelper(
  stateDir: string,
): (repoUrl: string) => string {
  const depCacheRoot = path.join(stateDir, "dep-cache");
  return (repoUrl: string): string => {
    return path.join(depCacheRoot, repoUrlToHash(repoUrl));
  };
}
