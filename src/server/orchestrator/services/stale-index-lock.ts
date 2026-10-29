// Gets the sync's rebase past a `.git/index.lock` that a dead git process left behind (planning#714).

import fs from "node:fs";
import path from "node:path";
import { getErrorMessage } from "../validation.js";

/** No real git step holds the index this long; a younger lock may still belong to a live command. */
export const STALE_INDEX_LOCK_MS = 10 * 60 * 1000;

// Git's lockfile message, which ref locks share; the path tells the index lock apart.
const LOCK_REFUSAL = /Unable to create '([^']+)': File exists/;

export interface IndexLockState {
  /** null when the lock was gone by the time ShipIt looked. */
  ageMs: number | null;
  /** Why a lock old enough to remove is still there. */
  removeError?: string;
}

const INDEX_LOCK_STATE = Symbol("shipit.indexLockState");

// Attached, not wrapped, so every classifier of the git error still sees git's own message.
function withIndexLockState<T>(err: T, state: IndexLockState): T {
  if (err !== null && typeof err === "object") {
    Object.defineProperty(err, INDEX_LOCK_STATE, { value: state, enumerable: false, configurable: true });
  }
  return err;
}

/** Set only when git refused on this workspace's own index lock. */
export function indexLockStateOf(err: unknown): IndexLockState | null {
  if (err === null || typeof err !== "object") return null;
  return ((err as Record<symbol, unknown>)[INDEX_LOCK_STATE] as IndexLockState | undefined) ?? null;
}

/** Waiting cannot clear this lock: it was old enough to remove, and it is still there. */
export function isStaleIndexLockKept(err: unknown): boolean {
  const state = indexLockStateOf(err);
  return state !== null && state.ageMs !== null && state.ageMs >= STALE_INDEX_LOCK_MS;
}

export function formatLockAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `${Math.floor(minutes / 60)} hours`;
}

// undefined when ShipIt cannot tell; the caller then lets git's error go up as it is.
function lockState(lock: string): IndexLockState | undefined {
  try {
    const stat = fs.lstatSync(lock, { throwIfNoEntry: false });
    return { ageMs: stat ? Math.max(0, Date.now() - stat.mtimeMs) : null };
  } catch {
    return undefined;
  }
}

function realOrSelf(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * Call inside `withWorkspaceLock`, so no orchestrator git step can own the lock. A session
 * workspace is a full clone, so its index lock is always `<workspace>/.git/index.lock`.
 */
export async function retryRemovingStaleIndexLock<T>(
  workspaceDir: string,
  turnRunning: () => boolean,
  gitStep: () => Promise<T>,
): Promise<T> {
  const lock = path.join(workspaceDir, ".git", "index.lock");
  // Git names the lock by the real path of the directory it ran in.
  const names = new Set([lock, path.join(realOrSelf(workspaceDir), ".git", "index.lock")]);
  const refusedOnLock = (err: unknown): boolean => {
    const refused = LOCK_REFUSAL.exec(getErrorMessage(err))?.[1];
    return refused !== undefined && names.has(path.resolve(refused));
  };
  try {
    return await gitStep();
  } catch (err) {
    const state = refusedOnLock(err) ? lockState(lock) : undefined;
    if (!state) throw err;
    if (state.ageMs === null || state.ageMs < STALE_INDEX_LOCK_MS || turnRunning()) {
      throw withIndexLockState(err, state);
    }
    try {
      fs.unlinkSync(lock);
    } catch (rmErr) {
      throw withIndexLockState(err, { ...state, removeError: getErrorMessage(rmErr) });
    }
    console.warn(`[rebase] removed a stale .git/index.lock (${formatLockAge(state.ageMs)} old) in ${workspaceDir}`);
  }
  try {
    return await gitStep();
  } catch (err) {
    const state = refusedOnLock(err) ? lockState(lock) : undefined;
    throw state ? withIndexLockState(err, state) : err;
  }
}
