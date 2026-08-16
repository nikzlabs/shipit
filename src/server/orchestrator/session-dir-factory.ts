import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import type Database from "better-sqlite3";
import type { SessionManager } from "./sessions.js";
import { repoUrlToHash } from "./git-utils.js";
import { sessionStateDir, SESSION_WORKSPACE_SUBDIR } from "./session-state-dir.js";
import { allocateSessionUid } from "./session-uid-allocator.js";
import { chownTreeToSessionWorker, sealSessionDir, sessionWorkerGid } from "./session-worker-uid.js";

// ---- Session directory creation ----

/** Dependencies for session directory creation. */
export interface SessionDirDeps {
  sessionsRoot: string;
  sessionManager: SessionManager;
  /**
   * docs/268 — the allocation ledger for per-session uids. Omitted in local /
   * dogfood mode and in tests, where the whole non-root runtime is off and every
   * session keeps today's shared identity.
   */
  db?: Database.Database;
}

/**
 * Create a factory function for creating new session directories.
 * The directory is created empty — the per-session clone (RepoGit.cloneFromCache)
 * happens separately.
 */
export function createSessionDirFactory(
  dirDeps: SessionDirDeps,
): (title: string) => Promise<{ appSessionId: string; sessionDir: string; workspaceDir: string }> {
  const { sessionsRoot, sessionManager, db } = dirDeps;

  return async (
    title: string,
  ): Promise<{ appSessionId: string; sessionDir: string; workspaceDir: string }> => {
    const appSessionId = crypto.randomUUID();
    const sessionDir = path.join(sessionsRoot, appSessionId);
    const workspaceDir = path.join(sessionDir, SESSION_WORKSPACE_SUBDIR);
    await fs.mkdir(workspaceDir, { recursive: true });

    // docs/246 — ShipIt's own generated artifacts live here, a sibling of the
    // clone, so the post-turn `git add -A` can never stage them into the user's
    // repository. Created up front: writers treat it as existing.
    await fs.mkdir(sessionStateDir(sessionDir), { recursive: true });

    // docs/268 — give the session its own uid and seal its directory, before
    // anything is written INTO it (the clone, the credential scaffold, the first
    // turn). Order matters in both directions: the mkdirs above must come first
    // so the handoff below has something to hand over, and this must come before
    // any content, because every later chown and every dropped orchestrator-side
    // git resolves the identity by reading this directory's owner.
    //
    // Gated on `sessionWorkerGid()`, i.e. on `SHIPIT_SESSION_WORKER_UID`: with
    // the non-root runtime off (local mode, dogfood, every test) nothing is
    // allocated and behaviour is byte-for-byte what it was.
    const sharedGid = sessionWorkerGid();
    if (db && sharedGid !== null) {
      const uid = allocateSessionUid(db);
      sealSessionDir(sessionDir, { uid, gid: sharedGid });
      // The directories just created are still `root:root`, and the seal
      // above is what makes every later chown and every dropped git resolve to
      // the allocated uid. Leaving them root-owned would mean a session whose
      // RECORD says one uid and whose contents say another — the state that
      // makes an unprivileged git EACCES on a tree ShipIt believes is its own.
      // The tree is empty here, so this is two `lchown`s, not a walk.
      chownTreeToSessionWorker(sessionDir);
    }
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
  return (repoUrl: string): string => {
    return path.join(bareCacheRoot(stateDir), repoUrlToHash(repoUrl));
  };
}

/**
 * The directory the per-repo bare caches live IN — `<hash>` children.
 *
 * Exported for the one caller that addresses a cache by a hash it did not
 * compute from a current URL: the docs/262 req 19 boot scrub, which has to find
 * a directory an OLDER build named after a credentialed URL.
 */
export function bareCacheRoot(stateDir: string): string {
  return path.join(stateDir, "repo-cache");
}

/** The directory the per-repo dependency caches live IN — see {@link bareCacheRoot}. */
export function depCacheRoot(stateDir: string): string {
  return path.join(stateDir, "dep-cache");
}

/**
 * Create the `getDepCacheDir` helper — returns a per-repo dependency cache
 * directory decoupled from the bare cache. Lives at {stateDir}/dep-cache/{hash}.
 */
export function createDepCacheDirHelper(
  stateDir: string,
): (repoUrl: string) => string {
  return (repoUrl: string): string => {
    return path.join(depCacheRoot(stateDir), repoUrlToHash(repoUrl));
  };
}
