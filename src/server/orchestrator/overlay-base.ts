/**
 * Overlay dep store — rolling-base publish logic (docs/183 Phase 3).
 *
 * This module owns the *decision* half of the overlay rolling base: which
 * candidate install result may become the next shared base for a
 * `(repo, runtime fingerprint)` scope, and how the per-scope base pointer rolls
 * forward. The *mechanism* half — the daemon-performed overlay mount and the
 * per-session volume — lives in `overlay-volume.ts`; the session-lifecycle
 * wiring (when to run install, how the worker exports the merged snapshot) is
 * Phase 4.
 *
 * The logic here is a faithful port of the validated prototype
 * (`docs/183-overlay-dep-store/prototype/rolling-base.ts`, 33/33 against a real
 * git repo), adapted to the production on-disk layout and extended with the
 * **force-push lineage reset** the prototype deferred.
 *
 * ## What it guarantees (plan §3 "Ordering rule")
 *
 * The published chain stays linear because publishing is restricted and ordered
 * by **`main`-commit ancestry, never wall-clock / lock-acquisition order**:
 *
 *   - Any session may run its install into its **own** `upperdir` (no shared
 *     state, never races) — that is NOT this module's concern.
 *   - Only an **exit-0**, **pre-user** install whose **recorded source base is
 *     the remote default-branch commit** may *publish* a new base.
 *   - A publish **advances** the base only when the candidate's commit strictly
 *     descends the current base's commit (`git merge-base --is-ancestor` true
 *     and the two differ). Equal → deps already current (no-op). Behind → the
 *     CAS "loser" declines. A **diverged** candidate that is the current remote
 *     default (a force-push rewrote `main`) is a **lineage reset**: rebuild a
 *     clean base from empty for the rewritten default, rather than leaving
 *     stale pre-rewrite content as every future session's lowerdir.
 *   - A short **per-scope lock** makes the read-compare-swap atomic, so a
 *     late-but-older publisher reads the newer base under the lock and declines.
 *
 * ## Generational bases (the swap-breaks-live-mounts fix)
 *
 * Base contents are **immutable generations**: `overlay-base/<scope-hash>/g<N>`.
 * A publish NEVER mutates or replaces an existing generation — it materializes
 * `g<N+1>` beside it and moves the pointer. The previous design renamed the new
 * contents over the single scope-hash path, assuming live mounts "keep the old,
 * now-unlinked inodes" unaffected; that assumption is FALSE — spike-proven on
 * the docs/183 measurement host (kernel 6.6): unlinking a mounted lowerdir
 * breaks merged-READDIR for every live same-scope mount (readdir returns empty
 * while path lookups still resolve), silently corrupting npm/tar/ls inside
 * those containers. Old generations are reaped by the disk-janitor once they
 * are no longer the pointer's current generation and have aged past the cutoff
 * (no plausible container pins a lowerdir that long).
 *
 * ## GC contract (plan §4 / disk-janitor `sweepOrphanedOverlayBases`)
 *
 * The scope dir `overlay-base/<scope-hash>/` is long-lived; each publish creates
 * a new `g<N>` child, which bumps the scope dir's own mtime (POSIX direct-child
 * change), so the disk-janitor's mtime liveness fallback stays sound. We
 * additionally `utimes` the scope dir to be explicit.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import { overlayBaseGenDir, overlayScopeHash } from "./overlay-volume.js";

// ---------------------------------------------------------------------------
// Scope + pointer types
// ---------------------------------------------------------------------------

/** The `(repo, runtime fingerprint[, dep-dir])` key a rolling base is keyed on. */
export interface OverlayScope {
  /** Canonical remote URL of the repo (same value `repoUrlToHash` consumes). */
  repoUrl: string;
  /**
   * Runtime fingerprint from `install-runtime.ts:runtimeKey()` — image digest +
   * arch + libc + Node ABI major. Describes ABI compatibility so a base with
   * compiled native addons/wheels is never reused across incompatible runtimes.
   */
  runtimeKey: string;
  /**
   * Declared dependency directory (relative path, e.g. `node_modules`) this base
   * holds, under the dep-dir design (docs/183). Each dep dir gets its own base.
   * Optional for backward compatibility: when absent the scope hashes to the
   * legacy `(repo, runtime)` identity (the single-base publish CAS path).
   */
  depDir?: string;
}

/** Persisted pointer for one scope's current rolling base. */
export interface BasePointer {
  /** `overlayScopeHash(repoUrl, runtimeKey)` — the scope identity on disk. */
  scopeHash: string;
  /** The `main` commit this base was built from — the ordering key. */
  commit: string;
  /** Incremental publishes stacked since the last clean rebuild (overlay depth). */
  depth: number;
  /** Generation counter — bumps on every advance, flatten, and lineage reset. */
  generation: number;
  /** Absolute orchestrator-visible path to this generation's contents (`overlay-base/<hash>/g<N>`). */
  baseDir: string;
  /** ISO timestamp of the last advance — diagnostics only, never an ordering input. */
  updatedAt: string;
  /**
   * The publisher's install-marker stamp ingredients, recorded so a fresh
   * session that mounts THIS base at the SAME commit can be pre-stamped with a
   * `.shipit/.install-done` the worker gate accepts — turning the "main
   * unchanged" scenario into a marker-skip instead of a full reinstall over the
   * populated base (see `preStampInstallMarker`). `runtimeKey` is the
   * publisher's WORKER-side fingerprint (`install-runtime.ts:runtimeKey()`,
   * what the gate compares against), NOT the orchestrator-side scope key.
   * Absent on pointers written before this field existed or when the publish
   * couldn't resolve the worker's runtime key — pre-stamp then declines.
   */
  marker?: { runtimeKey: string; installCommands: string[] };
}

/**
 * A finished install offered up as the next base. The eligibility fields encode
 * plan §3 rule (b); `snapshotDir` is the worker-exported **merged** workspace
 * tree (lower+upper, `.git` excluded), NOT the bare host upperdir — otherwise a
 * publish after a no-op install would drop every dependency that lived only in
 * the lowerdir (plan §4 "Publish/flatten from a worker-exported snapshot").
 */
export interface PublishCandidate {
  /** The `main` commit the source was fast-forwarded to before install. */
  commit: string;
  /** Install process exit code. Only 0 is publish-eligible. */
  exitCode: number;
  /** True iff the install ran before any user/agent dependency edit. */
  preUserInstall: boolean;
  /** True iff the recorded source base is the remote default-branch commit. */
  sourceIsDefaultBranch: boolean;
  /** Worker-exported merged-workspace snapshot to copy into the next base. */
  snapshotDir: string;
  /**
   * Install-marker ingredients recorded on the resulting pointer (see
   * `BasePointer.marker`). Optional — a publish without it still advances the
   * base; only the pre-stamp optimization is forgone.
   */
  markerStamp?: { runtimeKey: string; installCommands: string[] };
}

export type PublishOutcome =
  | "created" // first base for this scope (v0 from empty)
  | "advanced" // strictly-forward commit, base moved forward (depth++)
  | "flattened" // forward but depth cap hit → clean rebuild from empty
  | "reset" // force-push: candidate is current default but diverged → clean rebuild
  | "skipped-equal" // candidate commit == base commit (deps already current)
  | "skipped-not-forward" // behind the current base (CAS loser)
  | "skipped-ineligible"; // not exit-0 / not pre-user / source not default

export interface PublishResult {
  outcome: PublishOutcome;
  /** The pointer after the operation (unchanged for the skipped-* outcomes). */
  pointer: BasePointer | null;
}

/** `git merge-base --is-ancestor a b` — true iff `a` is an ancestor of `b`. */
export type IsAncestorFn = (ancestor: string, descendant: string) => Promise<boolean>;

/**
 * Substrate hook — materialize `snapshotDir` as the scope's NEXT base
 * generation and return that generation's dir. The default
 * (`copySnapshotToBase`) writes a fresh `overlay-base/<scope-hash>/g<generation>`
 * and never touches earlier generations (live mounts pin them — see the module
 * header). Injectable so tests don't copy real trees and a future
 * reflink/hardlink optimization can drop in.
 */
export type MaterializeFn = (
  snapshotDir: string,
  scopeHash: string,
  generation: number,
  /**
   * The scope's CURRENT generation dir (the one this publish supersedes), when
   * one exists. The default materializer hardlinks snapshot files that are
   * byte-identical to this generation's instead of copying them, so an advance
   * costs ≈ its delta on disk rather than a full independent tree. Optional —
   * absent for the first base of a scope, and safely ignorable by custom
   * materializers (tests).
   */
  linkDedupBaseDir?: string,
) => Promise<string>;

/**
 * Depth cap from plan §5 — a *specific tunable* (≈10–20), deliberately well
 * below the overlay hard limit, not the limit itself. On hit the base is
 * rebuilt clean from empty so every flatten doubles as a reproducibility reset.
 */
export const DEFAULT_DEPTH_CAP = 16;

// ---------------------------------------------------------------------------
// Pointer persistence
// ---------------------------------------------------------------------------

/**
 * Pointers live in a sibling subtree of the base contents, NOT inside
 * `overlay-base/<hash>/` (that dir is the overlay lowerdir — a stray pointer
 * file would surface in every session's merged workspace) and NOT as an entry
 * under `overlay-base/` itself (the disk-janitor sweeps that directory by
 * scope-hash and would reap a `pointers` entry). A dedicated top-level subtree
 * keeps both invariants.
 */
export const OVERLAY_POINTER_SUBDIR = "overlay-base-meta";

function pointerPath(stateDir: string, scopeHash: string): string {
  return path.join(stateDir, OVERLAY_POINTER_SUBDIR, `${scopeHash}.json`);
}

/** Read the current base pointer for a scope, or null if none exists yet. */
export function readBasePointer(stateDir: string, scope: OverlayScope): BasePointer | null {
  return readBasePointerByHash(stateDir, scopeHashOf(scope));
}

// Pointer reads/writes are deliberately SYNCHRONOUS (`fsSync`): the files are
// tiny, and the read-compare-swap must not yield mid-CAS inside the per-scope
// lock. Do not "modernize" these to `fs/promises` — an await here would open a
// window for an interleaving the lock is meant to prevent.
//
// Exported by-hash variant: the overlay spec populator resolves the mount's
// base generation per dep-dir scope hash (it has the hash, not the scope).
export function readBasePointerByHash(stateDir: string, scopeHash: string): BasePointer | null {
  try {
    const raw = fsSync.readFileSync(pointerPath(stateDir, scopeHash), "utf8");
    return JSON.parse(raw) as BasePointer;
  } catch {
    return null;
  }
}

function writeBasePointer(stateDir: string, pointer: BasePointer): void {
  const dir = path.join(stateDir, OVERLAY_POINTER_SUBDIR);
  fsSync.mkdirSync(dir, { recursive: true });
  const final = pointerPath(stateDir, pointer.scopeHash);
  const tmp = `${final}.tmp-${crypto.randomBytes(4).toString("hex")}`;
  fsSync.writeFileSync(tmp, JSON.stringify(pointer));
  fsSync.renameSync(tmp, final); // atomic swap — a torn read can never see a half-written pointer
}

function scopeHashOf(scope: OverlayScope): string {
  return overlayScopeHash(scope.repoUrl, scope.runtimeKey, scope.depDir);
}

// ---------------------------------------------------------------------------
// Per-scope in-process lock
// ---------------------------------------------------------------------------

/**
 * A single orchestrator process owns every publish, so an in-process async
 * mutex keyed by scope-hash is sufficient to serialize the read-compare-swap —
 * no cross-process file lock (and its cleanup hazards) is needed. Distinct
 * scopes publish concurrently; the same scope is strictly sequential.
 */
const scopeLocks = new Map<string, Promise<void>>();

async function withScopeLock<T>(scopeHash: string, fn: () => Promise<T>): Promise<T> {
  const prev = scopeLocks.get(scopeHash) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  // The new tail resolves only once this holder releases its gate, so the next
  // caller queues behind us. Built as an async IIFE (not `prev.then`) so a
  // prior holder's rejection doesn't poison the chain.
  scopeLocks.set(scopeHash, (async () => {
    try {
      await prev;
    } catch {
      /* a prior holder's failure is its own caller's problem */
    }
    await gate;
  })());
  try {
    await prev;
  } catch {
    // A prior holder's failure is its own caller's problem, not ours.
  }
  const tail = scopeLocks.get(scopeHash);
  try {
    return await fn();
  } finally {
    release();
    // If no later caller queued behind us, drop the entry so the map doesn't
    // grow without bound across many one-shot scopes.
    if (scopeLocks.get(scopeHash) === tail) scopeLocks.delete(scopeHash);
  }
}

// ---------------------------------------------------------------------------
// Hardlink-dedup materialize helpers
// ---------------------------------------------------------------------------

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.lstat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Byte-compare two regular files (streamed, early-exit on first difference).
 * Content is the ONLY authority for "unchanged" here: npm normalizes package
 * file mtimes to a fixed epoch for reproducibility, so a size+mtime quick
 * check would treat any same-size content change as unchanged — silently
 * linking the wrong bytes into a shared base. Sizes are checked by the caller
 * before this runs, so the compare only pays for genuinely plausible matches.
 */
async function filesContentEqual(a: string, b: string): Promise<boolean> {
  const CHUNK = 64 * 1024;
  const [fa, fb] = await Promise.all([fs.open(a, "r"), fs.open(b, "r")]);
  const bufA = Buffer.alloc(CHUNK);
  const bufB = Buffer.alloc(CHUNK);
  try {
    for (;;) {
      const [ra, rb] = await Promise.all([
        fa.read(bufA, 0, CHUNK),
        fb.read(bufB, 0, CHUNK),
      ]);
      if (ra.bytesRead !== rb.bytesRead) return false;
      if (ra.bytesRead === 0) return true;
      if (!bufA.subarray(0, ra.bytesRead).equals(bufB.subarray(0, rb.bytesRead))) {
        return false;
      }
    }
  } finally {
    await Promise.all([fa.close().catch(() => {}), fb.close().catch(() => {})]);
  }
}

/**
 * Materialize `srcDir` into `dstDir`, hardlinking any regular file that is
 * byte-identical (and mode-identical) to the file at the same relative path in
 * `linkDir`, and copying everything else. Directories are recreated with the
 * source's mode; symlinks are recreated verbatim (never hardlinked — a future
 * relink of the old generation must not alias the new one's link targets
 * through a shared symlink inode's metadata). Any per-file `link(2)` failure
 * (EXDEV, EMLINK, EPERM) degrades to a plain copy of that file — dedup is an
 * optimization, never a correctness dependency.
 */
async function materializeWithLinkDedup(
  srcDir: string,
  dstDir: string,
  linkDir: string,
): Promise<void> {
  const srcStat = await fs.lstat(srcDir);
  await fs.mkdir(dstDir, { recursive: true, mode: srcStat.mode & 0o7777 });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    const lnk = path.join(linkDir, entry.name);
    if (entry.isDirectory()) {
      await materializeWithLinkDedup(src, dst, lnk);
    } else if (entry.isSymbolicLink()) {
      await fs.symlink(await fs.readlink(src), dst);
    } else if (entry.isFile()) {
      if (await canHardlink(src, lnk)) {
        try {
          await fs.link(lnk, dst);
          continue;
        } catch {
          /* fall through to a plain copy */
        }
      }
      // COPYFILE_FICLONE: reflink when the fs supports it (btrfs/xfs), plain
      // copy otherwise (ext4) — same call either way, free where available.
      await fs.copyFile(src, dst, fsSync.constants.COPYFILE_FICLONE);
    } else {
      // FIFOs / devices should never appear in a dep snapshot (it comes from a
      // tar of a dep dir) — preserve fidelity with the generic copier.
      await fs.cp(src, dst, { recursive: true, verbatimSymlinks: true });
    }
  }
}

/** Same relative path in the previous generation is a regular file with equal size, mode, and content. */
async function canHardlink(srcFile: string, linkFile: string): Promise<boolean> {
  let prev;
  try {
    prev = await fs.lstat(linkFile);
  } catch {
    return false; // path is new in this snapshot
  }
  if (!prev.isFile()) return false;
  const cur = await fs.lstat(srcFile);
  if (prev.size !== cur.size) return false;
  if ((prev.mode & 0o7777) !== (cur.mode & 0o7777)) return false;
  return filesContentEqual(srcFile, linkFile);
}

// ---------------------------------------------------------------------------
// Default materialize: atomic swap of a snapshot copy over the base dir
// ---------------------------------------------------------------------------

/**
 * Copy `snapshotDir` into a fresh temp sibling inside the scope dir, then
 * atomically rename it to `overlay-base/<scope-hash>/g<generation>` — a brand-new
 * path. Earlier generations are NEVER touched: live overlay mounts pin their
 * lowerdir dentries, and unlinking a mounted lowerdir breaks merged-readdir for
 * every same-scope session (see the module header). Creating the new child
 * refreshes the scope dir's mtime (disk-janitor liveness contract); we `utimes`
 * it explicitly so the contract doesn't silently depend on rename semantics.
 *
 * Runs under the per-scope publish lock. If the target generation dir already
 * exists (a crash after a previous rename but before its pointer write), it is
 * unreferenced — no pointer ever named it — so it is cleared and rebuilt.
 */
export async function copySnapshotToBase(
  stateDir: string,
  snapshotDir: string,
  scopeHash: string,
  generation: number,
  linkDedupBaseDir?: string,
): Promise<string> {
  const genDir = overlayBaseGenDir(stateDir, scopeHash, generation);
  const scopeDir = path.dirname(genDir);
  await fs.mkdir(scopeDir, { recursive: true });

  const rand = crypto.randomBytes(4).toString("hex");
  const tmp = path.join(scopeDir, `.tmp-g${generation}-${rand}`);
  try {
    if (linkDedupBaseDir && (await isDirectory(linkDedupBaseDir))) {
      // Hardlink-dedup materialize: files byte-identical to the superseded
      // generation become hardlinks to its inodes, so an advance costs ≈ its
      // delta instead of a full independent ~0.5 GB tree (the docs/183 canary
      // measured consecutive generations sharing no inodes while differing by
      // hundreds of KB). Safe because generations are immutable read-only
      // lowerdirs — overlayfs never writes through a lower, the publish path
      // never edits an existing generation, and the janitor's reclaim of an
      // old generation only unlinks names (shared inodes survive in newer
      // generations by definition of hardlinks).
      await materializeWithLinkDedup(snapshotDir, tmp, linkDedupBaseDir);
    } else {
      // recursive copy; preserve symlinks rather than dereferencing them so a venv
      // or a pnpm store inside the tree round-trips faithfully.
      await fs.cp(snapshotDir, tmp, { recursive: true, verbatimSymlinks: true });
    }
  } catch (err) {
    // A partial copy must not leak a `.tmp-…` dir under the scope dir.
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  // A leftover gen dir from a crashed prior attempt (rename done, pointer write
  // not) was never referenced by a pointer and no mount can have resolved it
  // (specs read the pointer) — safe to clear before the rename.
  await fs.rm(genDir, { recursive: true, force: true }).catch(() => {});
  await fs.rename(tmp, genDir);

  const now = new Date();
  await fs.utimes(scopeDir, now, now).catch(() => {
    // Best-effort: the child create already refreshed the mtime on every real fs.
  });
  return genDir;
}

// ---------------------------------------------------------------------------
// The publish compare-and-swap
// ---------------------------------------------------------------------------

export interface PublishBaseArgs {
  stateDir: string;
  scope: OverlayScope;
  candidate: PublishCandidate;
  /** Ancestry oracle — typically `RepoGit`/`GitManager.isAncestor` over the bare cache. */
  isAncestor: IsAncestorFn;
  /**
   * The repo's CURRENT remote default-branch commit, resolved by the caller
   * under (or just before) the publish lock. Required to classify a divergence
   * as a force-push **lineage reset**: `candidate.sourceIsDefaultBranch` is only
   * a snapshot taken at install time, so a candidate that diverges from the base
   * might just be a stale install while `main` advanced *normally* — that must
   * be a skip, not a base-clobbering reset. We treat a divergence as a reset
   * ONLY when the candidate IS the current default. When omitted, divergence
   * conservatively skips (the prototype's behavior).
   */
  currentDefaultCommit?: string;
  depthCap?: number;
  /** Override the default snapshot copy (tests / future reflink path). */
  materialize?: MaterializeFn;
}

/**
 * Attempt to advance a scope's rolling base with `candidate`. The decision is
 * commit ancestry under a per-scope lock — see the module header for the full
 * ordering rule. Eligibility (exit-0 ∧ pre-user ∧ source==default) is checked
 * OUTSIDE the lock since it needs no shared state.
 */
export async function publishBase(args: PublishBaseArgs): Promise<PublishResult> {
  const { stateDir, scope, candidate, isAncestor } = args;
  const depthCap = args.depthCap ?? DEFAULT_DEPTH_CAP;
  const scopeHash = scopeHashOf(scope);
  const materialize: MaterializeFn =
    args.materialize ??
    ((snapshotDir, hash, generation, linkDedupBaseDir) =>
      copySnapshotToBase(stateDir, snapshotDir, hash, generation, linkDedupBaseDir));

  if (
    candidate.exitCode !== 0 ||
    !candidate.preUserInstall ||
    !candidate.sourceIsDefaultBranch
  ) {
    return {
      outcome: "skipped-ineligible",
      pointer: readBasePointerByHash(stateDir, scopeHash),
    };
  }

  return withScopeLock(scopeHash, async () => {
    const current = readBasePointerByHash(stateDir, scopeHash);

    // First base for this scope → v0 from empty.
    if (!current) {
      return finalize(stateDir, materialize, candidate, scopeHash, {
        outcome: "created",
        depth: 1,
        generation: 1,
      });
    }

    // Equal commit → deps already current, no-op.
    if (current.commit === candidate.commit) {
      return { outcome: "skipped-equal", pointer: current };
    }

    // Strictly forward → advance, or flatten at the depth cap.
    if (await isAncestor(current.commit, candidate.commit)) {
      const wouldBeDepth = current.depth + 1;
      if (wouldBeDepth >= depthCap) {
        // Dedup against the superseded generation is safe for a flatten too:
        // the snapshot's CONTENT comes from the clean reinstall (that is the
        // reproducibility reset); hardlinking bytes that happen to be
        // identical changes storage, not the tree.
        return finalize(stateDir, materialize, candidate, scopeHash, {
          outcome: "flattened",
          depth: 1,
          generation: current.generation + 1,
        }, current.baseDir);
      }
      return finalize(stateDir, materialize, candidate, scopeHash, {
        outcome: "advanced",
        depth: wouldBeDepth,
        generation: current.generation + 1,
      }, current.baseDir);
    }

    // Behind the current base → CAS loser, decline (an older default commit
    // grabbed the lock late). The session keeps its own tree; the base waits.
    if (await isAncestor(candidate.commit, current.commit)) {
      return { outcome: "skipped-not-forward", pointer: current };
    }

    // Neither ancestor → diverged. This is a force-push lineage reset ONLY if
    // the candidate is the repo's *current* default commit — otherwise it's a
    // stale install that diverges because `main` advanced normally in the
    // meantime, which must not clobber a healthy forward base. Reset rebuilds a
    // clean base from empty for the rewritten default; everything else skips.
    if (args.currentDefaultCommit && candidate.commit === args.currentDefaultCommit) {
      return finalize(stateDir, materialize, candidate, scopeHash, {
        outcome: "reset",
        depth: 1,
        generation: current.generation + 1,
      }, current.baseDir);
    }
    return { outcome: "skipped-not-forward", pointer: current };
  });
}

async function finalize(
  stateDir: string,
  materialize: MaterializeFn,
  candidate: PublishCandidate,
  scopeHash: string,
  next: { outcome: PublishOutcome; depth: number; generation: number },
  /** The superseded generation's dir — hardlink-dedup source (absent for a scope's first base). */
  linkDedupBaseDir?: string,
): Promise<PublishResult> {
  const baseDir = await materialize(candidate.snapshotDir, scopeHash, next.generation, linkDedupBaseDir);
  const pointer: BasePointer = {
    scopeHash,
    commit: candidate.commit,
    depth: next.depth,
    generation: next.generation,
    baseDir,
    updatedAt: new Date().toISOString(),
    ...(candidate.markerStamp ? { marker: candidate.markerStamp } : {}),
  };
  writeBasePointer(stateDir, pointer);
  return { outcome: next.outcome, pointer };
}

// ---------------------------------------------------------------------------
// GC live-source helper
// ---------------------------------------------------------------------------

/**
 * Whether the current base for a scope has reached the depth cap and the next
 * publish-eligible session should run a **clean reinstall** (mount an empty
 * lowerdir, whiteout the marker) so the exported snapshot is drift-free before
 * it flattens the base. Returns false when there is no base yet. The session
 * prep path consults this *before* install; `publishBase` independently records
 * the `flattened` outcome when the resulting pointer resets.
 */
export function shouldFlattenNext(
  stateDir: string,
  scope: OverlayScope,
  depthCap: number = DEFAULT_DEPTH_CAP,
): boolean {
  const current = readBasePointer(stateDir, scope);
  if (!current) return false;
  return current.depth + 1 >= depthCap;
}
