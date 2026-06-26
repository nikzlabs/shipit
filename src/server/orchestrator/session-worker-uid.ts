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
import { resolveShipitConfig, DEFAULT_DEP_DIRS } from "../shared/shipit-config.js";

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

/**
 * Hand a session workspace's `.git` directory back to the worker uid after the
 * root orchestrator ran git operations in it (clone, fetch, branch, reset,
 * commit). No-op when `SHIPIT_SESSION_WORKER_UID` is unset.
 *
 * docs/150 §7 addendum (SHI-31 activation): the worktree files are written by
 * the agent *as the worker uid* inside the container, but git's own writes —
 * `.git/index`, the reflogs under `.git/logs/` (append-only, so the worker
 * can't even add to a root-owned one), refs — land `root:root` whenever the
 * root orchestrator runs git here post-boot. The entrypoint's boot-time chown
 * can't see these later writes, so the next in-container `git` the agent runs
 * (uid 1000) fails to update them. Chowning after each orchestrator-side git op
 * closes that gap.
 *
 * Runs on the post-turn auto-commit (every turn) plus the one-shot session
 * setup writers, so it MUST stay cheap. The immutable DATA FILES under
 * `.git/objects/` (loose objects + packs) are deliberately skipped: git writes
 * them `0444` and content-addressed, so the worker only ever reads an existing
 * object or creates a NEW one — it never rewrites one in place, and a root-owned
 * `0444` file is world-readable anyway. The object *directories* (the ≤256-way
 * fanout + `pack/`/`info/`) ARE chowned, so the worker can still add new objects
 * into them. This bounds the walk by the fanout instead of the unbounded
 * loose-object count a `gc.auto=0` session clone accumulates — measured ~54 ms →
 * <1 ms on a 7k-loose-object repo (the ShipIt repo itself). Everything outside
 * `objects/` is chowned in full; that's where git's rewritten/appended files
 * (index, reflogs, refs, packed-refs, HEAD) live.
 */
export function chownWorkspaceGitToSessionWorker(workspaceDir: string): void {
  const uid = sessionWorkerUid();
  if (uid === null) return;
  const gitDir = path.join(workspaceDir, ".git");
  chownGitMetadataRecursive(gitDir, uid, path.join(gitDir, "objects"));
}

/**
 * Hand a session **worktree** (the files the agent edits) back to the worker
 * uid after the root orchestrator rewrote them. No-op when
 * `SHIPIT_SESSION_WORKER_UID` is unset.
 *
 * docs/150 §7 addendum (SHI-144): {@link chownWorkspaceGitToSessionWorker} hands
 * back `.git` so the agent's in-container *git* works, but NOT the worktree. A
 * root orchestrator `git rebase` / `checkout` / `rebase --continue` / `--abort`
 * re-materializes worktree files as `root:root` — including the conflicted files
 * the agent must **edit** to resolve. With only `.git` handed back, git status
 * passes but the resolution turn (and any later normal turn) still EACCES on
 * those files, and can't create/replace files in the now root-owned dirs. This
 * walks the worktree and chowns every node to the worker uid, EXCEPT `.git`
 * (handled by the object-aware helper) and the declared dep dirs
 * (`agent.dep-dirs`, e.g. `node_modules`) — passed in via `excludeRelDirs`.
 * Skipping the dep dirs keeps the walk bounded by the source tree instead of the
 * dependency count (those are large caches the entrypoint's one-shot chown / the
 * worker-run install already own; the rebase never touches them — they're
 * gitignored). Symlinks are chowned in place (`lchown`) and never followed.
 */
export function chownWorktreeToSessionWorker(workspaceDir: string, excludeRelDirs: string[] = []): void {
  const uid = sessionWorkerUid();
  if (uid === null) return;
  const exclude = new Set<string>([".git", ...excludeRelDirs.map((d) => path.normalize(d))]);
  chownWorktreeRecursive(workspaceDir, uid, workspaceDir, exclude);
}

/**
 * Hand a session workspace back to the worker uid in full after the root
 * orchestrator ran git operations that rewrote BOTH the `.git` metadata AND the
 * worktree files — `clone`/`checkout -b`/`reset --hard`/`rebase`/`merge`. No-op
 * when `SHIPIT_SESSION_WORKER_UID` is unset.
 *
 * This is the composite of the two narrower handbacks: {@link
 * chownWorkspaceGitToSessionWorker} (object-aware `.git`) +
 * {@link chownWorktreeToSessionWorker} (worktree minus the declared dep dirs,
 * read from the workspace's `shipit.yaml`; falls back to {@link DEFAULT_DEP_DIRS}
 * when the config can't be read). Handing back ONLY `.git` — which the
 * session-setup paths used to do — leaves the worktree the root git op
 * re-materialized owned `root:root`, so the non-root agent (uid 1000) can run
 * git but EACCESes on its first edit of a tracked file (docs/150 §7 / SHI-145).
 *
 * Use this from every orchestrator-side path that mutates a per-session
 * workspace's worktree as root: session setup (warm-pool create, claim refresh,
 * claim branch-off), rebase, and fork-merge. The dep-dir skip keeps the walk
 * bounded by the source tree rather than the (potentially populated)
 * `node_modules`, which the worker already owns via its own install / the
 * overlay mount.
 */
export function handWorkspaceBackToWorker(workspaceDir: string): void {
  if (sessionWorkerUid() === null) return;
  chownWorkspaceGitToSessionWorker(workspaceDir);
  let depDirs: string[];
  try {
    depDirs = resolveShipitConfig(workspaceDir).agent.depDirs;
  } catch {
    depDirs = [...DEFAULT_DEP_DIRS];
  }
  chownWorktreeToSessionWorker(workspaceDir, depDirs);
}

/**
 * Reconcile worker ownership of a per-session **dep-dir** writable layer, cheaply
 * — repairs root-owned tool caches a root process left inside it (e.g.
 * `node_modules/.vite`, written by a Compose dev server before #1646 ran services
 * as the worker uid). No-op when `SHIPIT_SESSION_WORKER_UID` is unset.
 *
 * The general {@link chownWorktreeToSessionWorker} self-heal deliberately
 * **excludes** the declared dep dirs: a full recursive chown of a populated
 * `node_modules` (tens of thousands of files) on every boot is too expensive, and
 * in overlay mode it would also rewrite the shared read-only lowerdir (docs/183).
 * So a root-owned cache that slipped *inside* a dep dir was never repaired and
 * wedged the next `npm run build` with EACCES (#1666 — the agent, uid 1000, can't
 * `rmdir` the root-owned `.vite/deps`, and has no `sudo` to recover).
 *
 * This pass is bounded and overlay-safe by construction:
 *  - it only `lstat`s the **direct children** of `depDirPath` (one per installed
 *    package + the dot-cache dirs), so the steady-state cost is a few hundred
 *    `lstat`s and **zero** chowns — the common case (everything already
 *    worker-owned from the worker-run install) is a shallow scan;
 *  - a child NOT owned by the worker uid is a leaked cache tree (a root process
 *    creates the whole `.vite/` subtree fresh), so it gets one wholesale
 *    {@link chownRecursive} — work bounded by the *leak* size, not the dep count;
 *  - `depDirPath` is always a **per-session** writable path — the plain
 *    `workspaceDir/<depDir>` (non-overlay) or the per-session overlay `upperdir`
 *    (where copy-ups/new dirs like `.vite` land) — never the shared overlay
 *    lowerdir, so reconciling it can never rewrite a base generation or trigger a
 *    copy-up storm.
 *
 * Idempotent: an already-worker-owned tree costs only the direct-child `lstat`s.
 * Tolerant: a missing `depDirPath` (no install yet) is a no-op.
 */
export function reconcileDepDirCacheOwnership(depDirPath: string): void {
  const uid = sessionWorkerUid();
  if (uid === null) return;
  let entries: string[];
  try {
    entries = fs.readdirSync(depDirPath);
  } catch {
    return; // dep dir doesn't exist yet (no install) — nothing to reconcile
  }
  for (const entry of entries) {
    const child = path.join(depDirPath, entry);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(child);
    } catch {
      continue; // vanished mid-scan
    }
    if (stat.uid !== uid || stat.gid !== uid) {
      // Leaked tree (root-owned cache a root process wrote here) — chown it whole.
      chownRecursive(child, uid);
    }
  }
}

/**
 * Recursive worktree chown that skips `.git` + the declared dep dirs (matched by
 * path relative to the worktree root, so a nested `client/node_modules` is
 * skipped too). Mirrors {@link chownRecursive} otherwise: chown every node,
 * descend real directories only (a symlink lstats as a non-directory, so it's
 * chowned in place and never followed out of the tree).
 */
function chownWorktreeRecursive(p: string, uid: number, root: string, exclude: Set<string>): void {
  const rel = path.relative(root, p);
  if (rel !== "" && exclude.has(rel)) return; // skip .git + declared dep dirs
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(p);
  } catch {
    return; // gone — nothing to own
  }
  lchownLogged(p, uid);
  if (stat.isDirectory()) {
    let entries: string[];
    try {
      entries = fs.readdirSync(p);
    } catch {
      return;
    }
    for (const entry of entries) {
      chownWorktreeRecursive(path.join(p, entry), uid, root, exclude);
    }
  }
}

function lchownLogged(p: string, uid: number): void {
  try {
    fs.lchownSync(p, uid, uid);
  } catch (err) {
    console.warn(`[session-worker-uid] chown failed for ${p}:`, err);
  }
}

/**
 * Recursive `.git` chown that treats the object store specially. Everywhere
 * outside `objectsDir` it behaves like {@link chownRecursive} (chown every node,
 * descend real dirs only — a symlink lstats as a non-directory, so it's never
 * followed out of the tree). At `objectsDir` (`.git/objects/`) it chowns the
 * store dir and its immediate subdirectories (the fanout dirs, `pack/`,
 * `info/`) so the worker can add new objects, then STOPS — it never descends to
 * even `lstat` the thousands of immutable `0444` data files. Avoiding that
 * per-file `lstat`/`lchown` is what keeps the walk O(fanout) instead of
 * O(loose objects); the store's growth under `gc.auto=0` otherwise made this
 * dominate (~54 ms → ~0.5 ms on a 7k-object repo). See
 * {@link chownWorkspaceGitToSessionWorker} for why skipping the data files is
 * safe.
 */
function chownGitMetadataRecursive(p: string, uid: number, objectsDir: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(p);
  } catch {
    return; // gone — nothing to own
  }

  if (p === objectsDir && stat.isDirectory()) {
    lchownLogged(p, uid);
    let entries: string[];
    try {
      entries = fs.readdirSync(p);
    } catch {
      return;
    }
    // Shallow: chown only the immediate subdirectories (fanout / pack / info).
    // Object/pack data files are left as-is — immutable, 0444, only ever read
    // or newly created, never rewritten in place.
    for (const entry of entries) {
      const child = path.join(p, entry);
      try {
        if (fs.lstatSync(child).isDirectory()) lchownLogged(child, uid);
      } catch {
        // entry vanished mid-walk — skip
      }
    }
    return;
  }

  lchownLogged(p, uid);
  if (stat.isDirectory()) {
    let entries: string[];
    try {
      entries = fs.readdirSync(p);
    } catch {
      return;
    }
    for (const entry of entries) {
      chownGitMetadataRecursive(path.join(p, entry), uid, objectsDir);
    }
  }
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
