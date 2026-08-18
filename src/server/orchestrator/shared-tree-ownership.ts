/**
 * planning#425 / planning#417 / planning#428 / docs/272-shared-cache-ownership —
 * the ownership contract for the git trees ShipIt keeps **outside** any session.
 *
 * ## The invariant, stated once because it was stated nowhere
 *
 * > A git tree ShipIt owns rather than a session is owned by the orchestrator's
 * > own identity, uniformly, and no session-derived identity ever appears inside
 * > it.
 *
 * `repo-cache/<hash>` is ONE tree with three writers holding three different
 * identities — the orchestrator's prefetch, a session's `clone --local`, and a
 * plugin generation's staging clone plus its install handover. Nothing said who
 * owned it, so each writer answered for itself, and production ended up with 6
 * of 10 caches owned by uid 1000, **root-owned subdirectories inside them**, and
 * object files owned by a per-session worker uid (docs/272 plan, "What
 * production established").
 *
 * Two consequences make the rest of the ownership machinery correct rather than
 * lucky:
 *
 *   - `resolveGitTreeUid` declines to drop on a root-owned tree because "the
 *     shared bare cache and `/opt/shipit` are ShipIt's own". That clearance was a
 *     claim about the disk until this module made it a repaired condition.
 *   - `chownWorkspaceGitToSessionWorker`, the container entrypoint, and
 *     `git-lfs-store.ts` all deliberately leave `.git/objects` data files alone
 *     because they are hardlinks into this tree. That only protects anything if
 *     the tree they point into is ShipIt's.
 *
 * ## Why repair, rather than teach the resolver to cope
 *
 * A **mixed** shared tree has no correct uid to run git as. Root can write all of
 * it but running root over a tree a non-root uid owns is precisely the escalation
 * docs/266 exists to prevent — that uid can plant a `.git/config` payload and so
 * choose the identity it executes at. The tree's own owner cannot write the parts
 * owned by anyone else, which is the production failure: prefetch resolved uid
 * 1000 from the top level and could not create `refs/heads/shipit/<x>.lock`
 * inside a root-owned subdirectory. There is no third answer to return, so the
 * only correct move is to stop the tree being mixed.
 *
 * ## THE DEBUGGING NOTE (docs/272 req 9)
 *
 * **A root process receiving `EACCES`/`EPERM` reads as impossible, and that
 * sends the reader down the wrong path for days.** In this codebase read it first
 * as *"the process dropped uid, and the tree is not uniformly owned."* Both
 * halves matter: docs/266 makes orchestrator-side git run as the uid that owns
 * the tree, so "we are root" stopped implying "we are root when it counts"; and
 * the drop is resolved from ONE stat of the top level, so a tree whose insides
 * disagree with its root produces a permission error that no amount of checking
 * the process's own privileges explains.
 *
 * ## Two entry points over one walk
 *
 *   - {@link ensureSharedTreeOwnedByShipIt} — the **cheap gate**, on the hot
 *     path. One `lstat`. It is a complete gate for the two production failures
 *     even though drift can hide deeper, because both need a foreign TOP LEVEL:
 *     the ref-lock EACCES needs the resolver to drop (it stats the top level),
 *     and `fatal: detected dubious ownership` is git checking the repository
 *     *root*.
 *   - {@link reclaimSharedTree} — the **full walk**, for the boot pass. It
 *     descends into `.git/objects` on purpose: that is where the ongoing
 *     hardlink drift lands (docs/272 req 2), and it is the one thing a cheap gate
 *     cannot see. Deliberately NOT on the hot path — it is O(objects).
 *
 * ## Inert unless the orchestrator is the privileged owner
 *
 * Everything here no-ops when `getuid() !== 0`, mirroring `resolveGitTreeUid`'s
 * own gate, so local mode, the dogfood inner instance and every test are
 * byte-for-byte unchanged (docs/272 req 11). A non-root process cannot chown a
 * foreign file anyway; asking would be an EPERM per node and a log line per file.
 *
 * The target is written as "the identity this process runs as" rather than the
 * literal 0 for the same reason: it makes the mechanism inert rather than *wrong*
 * anywhere the orchestrator is not root.
 *
 * ## Fail-safe by construction
 *
 * A failed `lchown` is counted and logged, never thrown: the caller's operation
 * is about to run either way, and the worst outcome of a failed repair is exactly
 * today's behaviour. That is why this needed no arming flag of its own, unlike
 * the removal of `safe.directory=*` — that one shipped behind a switch precisely
 * because it turns every missed call site into a hard failure at once (docs/272
 * plan, "Rejected alternatives"; the switch itself is gone as of planning#410).
 */

import fs from "node:fs";
import path from "node:path";

/** What a repair pass did. `inert` means the process is not root, so nothing ran. */
export interface ReclaimResult {
  /** Nodes handed back to the orchestrator's identity. */
  chowned: number;
  /** Nodes whose `lchown` failed (logged, never thrown). */
  failed: number;
  /** Nodes examined — the cost of the pass, so a log line can state it. */
  visited: number;
  /** True when the process is not root and nothing was attempted. */
  inert: boolean;
}

const INERT: ReclaimResult = { chowned: 0, failed: 0, visited: 0, inert: true };

/**
 * Injection seam. The interesting states — running as root, over a tree owned by
 * someone else — cannot be produced in a session container: it has no root and
 * `unshare -r` is refused. Same shape and same reason as
 * {@link import("../shared/git-tree-uid.js").GitTreeUidDeps}.
 */
export interface SharedTreeOwnershipDeps {
  getuid: () => number | undefined;
  getgid: () => number | undefined;
  /** Owner + kind of one node, or null when it cannot be read. Never follows a symlink. */
  lstat: (p: string) => { uid: number; gid: number; isDirectory: boolean } | null;
  /** Entry names, or null when the directory cannot be read. */
  readdir: (p: string) => string[] | null;
  /** `lchown`, so a symlink is re-owned in place and never followed. Throws on failure. */
  lchown: (p: string, uid: number, gid: number) => void;
}

export const defaultSharedTreeOwnershipDeps: SharedTreeOwnershipDeps = {
  getuid: () => process.getuid?.(),
  getgid: () => process.getgid?.(),
  lstat: (p: string) => {
    try {
      const st = fs.lstatSync(p);
      return { uid: st.uid, gid: st.gid, isDirectory: st.isDirectory() };
    } catch {
      return null;
    }
  },
  readdir: (p: string) => {
    try {
      return fs.readdirSync(p);
    } catch {
      return null;
    }
  },
  lchown: (p: string, uid: number, gid: number) => fs.lchownSync(p, uid, gid),
};

/** The identity a shared tree must belong to, or null when we are not root. */
function orchestratorIdentity(deps: SharedTreeOwnershipDeps): { uid: number; gid: number } | null {
  if (deps.getuid() !== 0) return null;
  const uid = deps.getuid();
  const gid = deps.getgid();
  if (uid === undefined || gid === undefined) return null;
  return { uid, gid };
}

/**
 * Walk `dir` and hand every node that is not already the orchestrator's back to
 * it. Idempotent — a tree that is already uniform costs one `lstat` per node and
 * zero chowns, which is what makes it safe to run on every boot.
 *
 * Symlinks are re-owned in place and never traversed (`lstat` + `lchown`),
 * matching `chownRecursive`'s semantics in `session-worker-uid.ts`, so a stray
 * link inside a cache cannot walk the pass out of the tree.
 *
 * **It descends into `.git/objects`, unlike every other walk in this codebase.**
 * The others skip object data files precisely because they are hardlinks into
 * this tree and chowning one there would hand a session ownership of shared
 * content. Here the direction is reversed: this IS that tree, and the drift to
 * repair is exactly those inodes (`imagegen`'s cache had object files owned by
 * 2000024, a per-session worker uid). Restoring them converges on the state
 * every other walk assumes. Safe for a live session clone that shares them, for
 * three reasons worth stating separately because only the third is obvious:
 *
 *   - `clone --local` hardlinks **files**, never directories: every directory in
 *     a session's `.git/objects` is its own inode, so this pass cannot reach one.
 *     A session's fanout directories stay session-owned however often this runs,
 *     which is what keeps `git prune`, `git repack`'s pack removal and
 *     `git lfs prune` working — unlinking an entry is governed by the
 *     *directory's* permissions, not the file's.
 *   - Git never rewrites an object in place. It reads an existing one or creates
 *     a new one (in a directory it owns), so a `0444` root-owned object is a file
 *     it only ever opens for reading.
 *   - Those files are world-readable `0444` to begin with, so nothing loses read
 *     access.
 *
 * This is also why there is no chown war with the container entrypoint or
 * `chownWorkspaceGitToSessionWorker`: both deliberately skip object data files,
 * so no other writer is trying to pull the same inodes the other way.
 */
export function reclaimSharedTree(
  dir: string,
  deps: SharedTreeOwnershipDeps = defaultSharedTreeOwnershipDeps,
): ReclaimResult {
  const owner = orchestratorIdentity(deps);
  if (owner === null) return INERT;
  const result: ReclaimResult = { chowned: 0, failed: 0, visited: 0, inert: false };
  walk(dir, owner, deps, result);
  return result;
}

function walk(
  p: string,
  owner: { uid: number; gid: number },
  deps: SharedTreeOwnershipDeps,
  result: ReclaimResult,
): void {
  const st = deps.lstat(p);
  if (st === null) return; // vanished or unreadable — nothing to own
  result.visited += 1;
  if (st.uid !== owner.uid || st.gid !== owner.gid) {
    try {
      deps.lchown(p, owner.uid, owner.gid);
      result.chowned += 1;
    } catch (err) {
      result.failed += 1;
      console.warn(`[shared-tree-ownership] could not reclaim ${p}:`, err);
    }
  }
  if (!st.isDirectory) return;
  const entries = deps.readdir(p);
  if (entries === null) return;
  for (const entry of entries) walk(path.join(p, entry), owner, deps, result);
}

/**
 * The cheap gate: make sure `dir` is ShipIt's own before running git on it.
 *
 * One `lstat` in the steady state. A foreign owner triggers the full
 * {@link reclaimSharedTree} and says so loudly — `context` names the operation
 * that was about to run, so the log line answers "why is this happening now".
 *
 * ## Which operations call it, stated precisely
 *
 * NOT "every git that touches a shared cache" — `fetchCache` and
 * `cloneFromCache`, which are the operations that can **fail**. The rest are safe
 * without it for a structural reason worth keeping: the drop is resolved from the
 * tree's **top level**, so the identity git runs as always owns the top level, and
 * a write *at* the top level therefore cannot fail. That covers `setRemoteUrl`
 * (`config.lock` in the cache root — it kept working throughout the production
 * incident, including where it runs *before* `fetchCache` on the warm-pool path)
 * and the startup janitor's branch sweep. The failures are exactly the operations
 * that go **deeper**: a ref lock under `refs/heads/shipit/` (planning#425) and a
 * clone that reads the whole object store (planning#428).
 *
 * Call it from those operations rather than from a funnel that looks like it
 * covers them. `ensureBareCache`'s docstring claims to be "called by every path
 * that operates on a bare cache"; it is not — `warm-pool-manager.ts` builds its
 * `RepoGit` directly and fetches and clones without it (verified at the source,
 * docs/272 plan).
 */
export function ensureSharedTreeOwnedByShipIt(
  dir: string,
  context: string,
  deps: SharedTreeOwnershipDeps = defaultSharedTreeOwnershipDeps,
): ReclaimResult {
  const owner = orchestratorIdentity(deps);
  if (owner === null) return INERT;
  const st = deps.lstat(dir);
  // A missing tree is not a tree to reason about: the caller's own git will fail
  // on it for its own reasons (or, for `ensureBareCache`, re-clone it).
  if (st === null) return { chowned: 0, failed: 0, visited: 0, inert: false };
  if (st.uid === owner.uid && st.gid === owner.gid) {
    return { chowned: 0, failed: 0, visited: 1, inert: false };
  }
  console.warn(
    `[shared-tree-ownership] ${context}: ${dir} is owned by ${st.uid}:${st.gid}, not by ShipIt `
    + `(${owner.uid}:${owner.gid}) — reclaiming it. A shared cache is ShipIt's own tree; a foreign `
    + "owner makes orchestrator-side git either drop to an identity we did not choose or refuse the "
    + "repository outright (planning#425, planning#428).",
  );
  const result = reclaimSharedTree(dir, deps);
  console.warn(
    `[shared-tree-ownership] ${context}: reclaimed ${result.chowned} of ${result.visited} nodes under `
    + `${dir}${result.failed > 0 ? `, ${result.failed} could not be reclaimed` : ""}`,
  );
  return result;
}

/**
 * Reclaim every child of a root that holds shared trees — `repo-cache/`,
 * `marketplace-cache/`. Used by the boot pass, which is the only place the full
 * walk belongs: ownership drift is leftover state from previous incarnations, not
 * something that grows with the clock (`CLAUDE.md`'s disk-cleanup split).
 *
 * A missing root is a no-op: a deployment that has never cached a repository has
 * nothing to repair.
 */
export function reclaimSharedTreesUnder(
  root: string,
  context: string,
  deps: SharedTreeOwnershipDeps = defaultSharedTreeOwnershipDeps,
): ReclaimResult {
  const owner = orchestratorIdentity(deps);
  if (owner === null) return INERT;
  const entries = deps.readdir(root);
  if (entries === null) return { chowned: 0, failed: 0, visited: 0, inert: false };
  const total: ReclaimResult = { chowned: 0, failed: 0, visited: 0, inert: false };
  for (const entry of entries) {
    const child = path.join(root, entry);
    const st = deps.lstat(child);
    if (!st?.isDirectory) continue;
    const result = reclaimSharedTree(child, deps);
    total.chowned += result.chowned;
    total.failed += result.failed;
    total.visited += result.visited;
  }
  if (total.chowned > 0 || total.failed > 0) {
    console.log(
      `[shared-tree-ownership] ${context}: reclaimed ${total.chowned} node(s) across ${root}`
      + `${total.failed > 0 ? `, ${total.failed} could not be reclaimed` : ""}. Ongoing drift comes `
      + "from `clone --local` hardlink sharing (planning#417); the object-aware handbacks are what "
      + "stop it recurring.",
    );
  }
  return total;
}
