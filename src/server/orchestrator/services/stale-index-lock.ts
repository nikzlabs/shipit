// Gets the sync's rebase past a `.git/index.lock` that a dead git process left behind (planning#714).

import fs from "node:fs";
import path from "node:path";
import { getErrorMessage } from "../validation.js";

/** No real git step holds the index this long; a younger lock may still belong to a live command. */
export const STALE_INDEX_LOCK_MS = 10 * 60 * 1000;

const INDEX_LOCK_REFUSAL = /Unable to create '[^']*index\.lock': File exists/;

export function isIndexLockRefusal(message: string): boolean {
  return INDEX_LOCK_REFUSAL.test(message);
}

export interface IndexLockState {
  /** null when ShipIt found no lock after git's refusal. */
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

function lockAgeMs(lock: string): number | null {
  try {
    const stat = fs.lstatSync(lock, { throwIfNoEntry: false });
    return stat ? Math.max(0, Date.now() - stat.mtimeMs) : null;
  } catch {
    return null;
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
  try {
    return await gitStep();
  } catch (err) {
    if (!isIndexLockRefusal(getErrorMessage(err))) throw err;
    const ageMs = lockAgeMs(lock);
    if (ageMs === null || ageMs < STALE_INDEX_LOCK_MS || turnRunning()) {
      throw withIndexLockState(err, { ageMs });
    }
    try {
      fs.unlinkSync(lock);
    } catch (rmErr) {
      throw withIndexLockState(err, { ageMs, removeError: getErrorMessage(rmErr) });
    }
    console.warn(`[rebase] removed a stale .git/index.lock (${formatLockAge(ageMs)} old) in ${workspaceDir}`);
  }
  try {
    return await gitStep();
  } catch (err) {
    throw isIndexLockRefusal(getErrorMessage(err)) ? withIndexLockState(err, { ageMs: lockAgeMs(lock) }) : err;
  }
}
