/**
 * Orchestrator-side ownership handoff to the unprivileged session worker user
 * (docs/150 §7).
 *
 * The session-worker container drops to the `shipit` user (UID/GID 1000) at
 * boot, but the **orchestrator** container stays root and keeps writing into
 * each session's mounted subtrees *after* the container has started —
 * credential refreshes every turn, the per-session gitconfig, user uploads,
 * CI-fix logs, post-boot git operations. Node's copy primitives preserve the
 * source mode and the upstream credential files are `0600 root:root`, so those
 * writes land `root:root` and are unreadable to `shipit`. The container
 * entrypoint's chown runs only once, at boot, so it cannot cover them.
 *
 * The fix is symmetric to the entrypoint: every orchestrator-side writer into a
 * per-session mount chowns its output to the worker UID right after writing.
 * All of it is gated on a single env var, `SHIPIT_SESSION_WORKER_UID`:
 *
 *   - **unset** (today's default) → every helper here is a no-op, preserving
 *     the legacy root-writes-everything behavior. Safe to deploy before the
 *     non-root image exists.
 *   - **set to `1000`** → chowns fire. The session-worker image's entrypoint
 *     reads the *same* env var, so a single deploy flips both sides together
 *     and they can never disagree about which UID owns the mounts (docs/150
 *     Rollout step 3).
 */

import fs from "node:fs";
import path from "node:path";

/**
 * The UID the session worker runs as, parsed from `SHIPIT_SESSION_WORKER_UID`,
 * or `null` when unset/invalid. `null` means "do not chown" — the orchestrator
 * and worker are both still on root.
 */
export function sessionWorkerUid(): number | null {
  const raw = process.env.SHIPIT_SESSION_WORKER_UID;
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Chown a single file/dir (non-recursive) to the session worker UID/GID. No-op
 * when `SHIPIT_SESSION_WORKER_UID` is unset. Best-effort: a chown failure (e.g.
 * the path vanished mid-flight) is logged, never thrown — the caller's write
 * already succeeded and a stale-ownership read surfaces as an auth failure the
 * next sync repairs.
 */
export function chownToSessionWorker(targetPath: string): void {
  const uid = sessionWorkerUid();
  if (uid === null) return;
  try {
    fs.lchownSync(targetPath, uid, uid);
  } catch (err) {
    console.warn(`[session-worker-uid] chown failed for ${targetPath}:`, err);
  }
}

/**
 * Recursively chown a subtree to the session worker UID/GID. No-op when
 * `SHIPIT_SESSION_WORKER_UID` is unset.
 *
 * Mirrors `chown -R` semantics: symlinks are chowned in place (`lchown`) and
 * never traversed, so a credential subtree's legacy-alias symlinks don't drag
 * the walk outside the per-session dir. Missing paths are tolerated (a write
 * may have been torn down concurrently).
 */
export function chownTreeToSessionWorker(targetPath: string): void {
  const uid = sessionWorkerUid();
  if (uid === null) return;
  chownRecursive(targetPath, uid);
}

function chownRecursive(p: string, uid: number): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(p);
  } catch {
    return; // gone — nothing to own
  }
  try {
    fs.lchownSync(p, uid, uid);
  } catch (err) {
    console.warn(`[session-worker-uid] chown failed for ${p}:`, err);
  }
  // Recurse into real directories only. A symlink to a directory has
  // `isDirectory() === false` on the lstat above, so we never follow it.
  if (stat.isDirectory()) {
    let entries: string[];
    try {
      entries = fs.readdirSync(p);
    } catch {
      return;
    }
    for (const entry of entries) {
      chownRecursive(path.join(p, entry), uid);
    }
  }
}
