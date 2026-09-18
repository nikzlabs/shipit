import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import type { SessionManager } from "./sessions.js";
import { repoUrlToHash } from "./git-utils.js";
import { sessionStateDir, SESSION_WORKSPACE_SUBDIR } from "./session-state-dir.js";
import { allocateAndSealSessionDir } from "./session-uid-allocator.js";
import { chownTreeToSessionWorker } from "./session-worker-uid.js";

export interface SessionDirDeps {
  sessionsRoot: string;
  sessionManager: SessionManager;
}

export function createSessionDirFactory(
  dirDeps: SessionDirDeps,
): (title: string) => Promise<{ appSessionId: string; sessionDir: string; workspaceDir: string }> {
  const { sessionsRoot, sessionManager } = dirDeps;

  return async (
    title: string,
  ): Promise<{ appSessionId: string; sessionDir: string; workspaceDir: string }> => {
    const appSessionId = crypto.randomUUID();
    const sessionDir = path.join(sessionsRoot, appSessionId);
    const workspaceDir = path.join(sessionDir, SESSION_WORKSPACE_SUBDIR);
    await fs.mkdir(workspaceDir, { recursive: true });

    // Keep generated state outside the clone so auto-commit cannot stage it.
    await fs.mkdir(sessionStateDir(sessionDir), { recursive: true });

    // Set ownership before writing content: later git and chown calls derive the uid here.
    if (allocateAndSealSessionDir(sessionDir) !== null) {
      chownTreeToSessionWorker(sessionDir);
    }
    sessionManager.track(appSessionId, title, workspaceDir);
    console.log("[server] Created session directory:", sessionDir);

    return { appSessionId, sessionDir, workspaceDir };
  };
}

export function createBareCacheDirHelper(
  stateDir: string,
): (repoUrl: string) => string {
  return (repoUrl: string): string => {
    return path.join(bareCacheRoot(stateDir), repoUrlToHash(repoUrl));
  };
}

export function bareCacheRoot(stateDir: string): string {
  return path.join(stateDir, "repo-cache");
}

export function depCacheRoot(stateDir: string): string {
  return path.join(stateDir, "dep-cache");
}

export function createDepCacheDirHelper(
  stateDir: string,
): (repoUrl: string) => string {
  return (repoUrl: string): string => {
    return path.join(depCacheRoot(stateDir), repoUrlToHash(repoUrl));
  };
}
