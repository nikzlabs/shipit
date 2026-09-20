// docs/276 H1 — npm's `_cacache` holds two things with different trust properties.
// `content-v2` is addressed by the hash of its own bytes and re-hashed on every read
// (`cacache/lib/content/read.js`), so a session cannot make another session install
// bytes of its choosing through it. `index-v5` is plain resolution data: rewrite a
// packument's `dist.integrity` to content the attacker placed at its own valid hash,
// set `hasInstallScript`, and the next session's `npm install` runs the attacker's
// postinstall — even with the network up, because npm serves a fresh cache entry
// without asking the registry.
//
// So the index is private per session and the content stays shared. The split is a
// symlink rather than a mount on purpose: `npm cache clean --force` rm -rf's the
// whole cache root, which through a mount would delete the repo's shared store and
// then fail EBUSY, while it merely unlinks a symlink.

import fs from "node:fs";
import path from "node:path";
import { CONTAINER_SESSION_STATE_DIR, DEP_CACHE_CONTAINER_PATH } from "./fs-constants.js";

export const SESSION_NPM_CACHE_SUBDIR = "npm-cache";

/** Per-session npm cache root, inside the session-state mount — no extra mount needed. */
export function sessionNpmCacheDir(stateDir: string = CONTAINER_SESSION_STATE_DIR): string {
  return path.join(stateDir, SESSION_NPM_CACHE_SUBDIR);
}

export function sharedNpmCacheDir(depCacheDir: string): string {
  return path.join(depCacheDir, "npm");
}

export function sharedNpmContentDir(depCacheDir: string): string {
  return path.join(sharedNpmCacheDir(depCacheDir), "_cacache", "content-v2");
}

export function sharedNpmIndexDir(depCacheDir: string): string {
  return path.join(sharedNpmCacheDir(depCacheDir), "_cacache", "index-v5");
}

export type NpmCacheSplitOutcome =
  | { shared: true; relinked: boolean; discardedPrivateContent: boolean }
  | { shared: false; reason: string };

/**
 * Run in the session container before anything may invoke npm. Creates the private
 * cache root and points its `content-v2` at the repo's shared store.
 */
export function prepareSessionNpmCache(
  cacheRoot: string,
  sharedContentDir: string,
): NpmCacheSplitOutcome {
  const contentLink = path.join(cacheRoot, "_cacache", "content-v2");
  try {
    fs.mkdirSync(path.dirname(contentLink), { recursive: true });
  } catch (err) {
    return { shared: false, reason: message(err) };
  }

  try {
    fs.mkdirSync(sharedContentDir, { recursive: true });
  } catch (err) {
    return fallBackToPrivate(contentLink, err);
  }

  let discardedPrivateContent = false;
  const existing = lstatOrNull(contentLink);
  if (existing?.isSymbolicLink()) {
    if (readlinkOrNull(contentLink) === sharedContentDir) {
      return { shared: true, relinked: false, discardedPrivateContent: false };
    }
  } else if (existing !== null) {
    // A real directory here means npm ran without the link — after `npm cache clean
    // --force`, say. Its blobs are re-fetchable and self-verifying, so discard them
    // rather than leave this session permanently unshared.
    discardedPrivateContent = true;
  }

  try {
    fs.rmSync(contentLink, { recursive: true, force: true });
    fs.symlinkSync(sharedContentDir, contentLink);
  } catch (err) {
    return fallBackToPrivate(contentLink, err);
  }
  return { shared: true, relinked: true, discardedPrivateContent };
}

/**
 * A link we cannot honour is worse than no link: npm would follow it and fail to write
 * content, so "unshared but working" is only true once the link is gone. Never removes a
 * real directory — that holds this session's own content.
 */
function fallBackToPrivate(contentLink: string, err: unknown): NpmCacheSplitOutcome {
  const reason = message(err);
  if (lstatOrNull(contentLink)?.isSymbolicLink() !== true) return { shared: false, reason };
  try {
    fs.rmSync(contentLink, { force: true });
    return { shared: false, reason };
  } catch (rmErr) {
    return { shared: false, reason: `${reason}; the stale link also survived: ${message(rmErr)}` };
  }
}

/**
 * Worker entry point. `npm_config_cache` is what the orchestrator decided, so keying off
 * it means the layout can never be prepared somewhere npm will not look — a session with
 * no shared dep cache keeps npm's own private default and needs no split.
 */
export function linkSessionNpmCache(
  stateDir: string,
  depCacheDir: string = DEP_CACHE_CONTAINER_PATH,
  env: NodeJS.ProcessEnv = process.env,
): NpmCacheSplitOutcome | null {
  const cacheRoot = sessionNpmCacheDir(stateDir);
  if (env.npm_config_cache !== cacheRoot) return null;

  const outcome = prepareSessionNpmCache(cacheRoot, sharedNpmContentDir(depCacheDir));
  // From the worker, not the orchestrator: the shared tree is group-owned by the session
  // gid, and orchestrator root has no DAC_OVERRIDE to fall back on.
  if (pruneSharedNpmIndex(depCacheDir)) {
    console.log(`[npm-cache] retired the shared npm resolution index under ${depCacheDir}`);
  }
  if (!outcome.shared) {
    console.warn(
      `[npm-cache] ${cacheRoot} is not sharing the repo's npm content store ` +
      `(${outcome.reason}); installs will re-download rather than reuse it`,
    );
    return outcome;
  }
  if (outcome.discardedPrivateContent) {
    console.log(`[npm-cache] discarded unshared npm content left in ${cacheRoot} and relinked the shared store`);
  }
  return outcome;
}

/**
 * Retire the shared resolution index. After the split nothing reads it, so it is
 * both dead weight and the one surface H1 was exploitable through.
 */
export function pruneSharedNpmIndex(depCacheDir: string): boolean {
  const dir = sharedNpmIndexDir(depCacheDir);
  if (lstatOrNull(dir) === null) return false;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (err) {
    console.warn(`[npm-cache] could not retire the shared npm resolution index ${dir}:`, message(err));
    return false;
  }
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function readlinkOrNull(p: string): string | null {
  try {
    return fs.readlinkSync(p);
  } catch {
    return null;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
