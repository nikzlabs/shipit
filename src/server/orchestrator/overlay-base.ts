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
 * ## GC contract (plan §4 / disk-janitor `sweepOrphanedOverlayBases`)
 *
 * The base lives in a single long-lived `overlay-base/<scope-hash>/` directory
 * that rolls forward in place. POSIX only bumps a directory's own mtime on a
 * direct-child change, so the disk-janitor's mtime liveness fallback is sound
 * ONLY if every advance **rewrites the top-level dir entry**. We therefore
 * materialize every new base into a temp sibling and atomically swap it over the
 * scope-hash path (which also keeps any live overlay mount referencing the old,
 * now-unlinked inodes — overlay requires an immutable lower). The swap gives the
 * dir a fresh mtime for free; we additionally `utimes` it to be explicit.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import { OVERLAY_BASE_SUBDIR, overlayBaseDir, overlayScopeHash } from "./overlay-volume.js";

// ---------------------------------------------------------------------------
// Scope + pointer types
// ---------------------------------------------------------------------------

/** The `(repo, runtime fingerprint)` pair a rolling base is keyed on. */
export interface OverlayScope {
  /** Canonical remote URL of the repo (same value `repoUrlToHash` consumes). */
  repoUrl: string;
  /**
   * Runtime fingerprint from `install-runtime.ts:runtimeKey()` — image digest +
   * arch + libc + Node ABI major. Describes ABI compatibility so a base with
   * compiled native addons/wheels is never reused across incompatible runtimes.
   */
  runtimeKey: string;
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
  /** Absolute orchestrator-visible path to the base contents (`overlay-base/<hash>`). */
  baseDir: string;
  /** ISO timestamp of the last advance — diagnostics only, never an ordering input. */
  updatedAt: string;
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
 * Substrate hook — materialize `snapshotDir` as the scope's base contents and
 * return the base dir. The default (`copySnapshotToBase`) atomically swaps a
 * fresh copy over `overlay-base/<scope-hash>`. Injectable so tests don't copy
 * real trees and a future reflink/hardlink optimization can drop in.
 */
export type MaterializeFn = (
  snapshotDir: string,
  scopeHash: string,
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
function readBasePointerByHash(stateDir: string, scopeHash: string): BasePointer | null {
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
  return overlayScopeHash(scope.repoUrl, scope.runtimeKey);
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
// Default materialize: atomic swap of a snapshot copy over the base dir
// ---------------------------------------------------------------------------

/**
 * Copy `snapshotDir` into a fresh temp sibling, then atomically swap it over
 * `overlay-base/<scope-hash>`. Live overlay mounts keep the old (now-unlinked)
 * inodes — overlay pins lowerdir dentries at mount time — so an in-flight
 * session is unaffected while new sessions resolve the new contents. The swap
 * gives the dir a fresh mtime, satisfying the disk-janitor liveness contract;
 * we `utimes` it explicitly so the contract doesn't silently depend on rename
 * semantics.
 */
export async function copySnapshotToBase(
  stateDir: string,
  snapshotDir: string,
  scopeHash: string,
): Promise<string> {
  const baseDir = overlayBaseDir(stateDir, scopeHash);
  const overlayRoot = path.join(stateDir, OVERLAY_BASE_SUBDIR);
  await fs.mkdir(overlayRoot, { recursive: true });

  const rand = crypto.randomBytes(4).toString("hex");
  const tmp = path.join(overlayRoot, `.tmp-${scopeHash}-${rand}`);
  try {
    // recursive copy; preserve symlinks rather than dereferencing them so a venv
    // or a pnpm store inside the tree round-trips faithfully.
    await fs.cp(snapshotDir, tmp, { recursive: true, verbatimSymlinks: true });
  } catch (err) {
    // A partial copy must not leak a `.tmp-…` dir under overlay-base/.
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  // Swap so a crash never leaves the scope-hash path *missing*: move the old
  // contents aside first, rename the fresh copy into place, then drop the old.
  // A crash between any two steps leaves either the old or the new dir at
  // `baseDir`, never neither. Live overlay mounts keep their pinned (now-
  // unlinked) lowerdir inodes, so an in-flight session is unaffected. All of
  // this runs under the per-scope publish lock, so no publisher races it.
  const old = `${baseDir}.old-${rand}`;
  let hadOld = true;
  try {
    await fs.rename(baseDir, old);
  } catch {
    hadOld = false; // ENOENT on the first publish for this scope — nothing to move
  }
  await fs.rename(tmp, baseDir);
  if (hadOld) await fs.rm(old, { recursive: true, force: true }).catch(() => {});

  const now = new Date();
  await fs.utimes(baseDir, now, now).catch(() => {
    // Best-effort: the rename already refreshed the mtime on every real fs.
  });
  return baseDir;
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
    ((snapshotDir, hash) => copySnapshotToBase(stateDir, snapshotDir, hash));

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
        return finalize(stateDir, materialize, candidate, scopeHash, {
          outcome: "flattened",
          depth: 1,
          generation: current.generation + 1,
        });
      }
      return finalize(stateDir, materialize, candidate, scopeHash, {
        outcome: "advanced",
        depth: wouldBeDepth,
        generation: current.generation + 1,
      });
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
      });
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
): Promise<PublishResult> {
  const baseDir = await materialize(candidate.snapshotDir, scopeHash);
  const pointer: BasePointer = {
    scopeHash,
    commit: candidate.commit,
    depth: next.depth,
    generation: next.generation,
    baseDir,
    updatedAt: new Date().toISOString(),
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
