/**
 * PROTOTYPE — keyless rolling-base publish logic for docs/183-overlay-dep-store.
 *
 * This is the explicitly first-sequenced spike from the plan: model the
 * **keyless rolling base on the current (copy) substrate** so the chain logic
 * can be validated *before* the host-side overlay mount (the real gating risk)
 * is built. It is deliberately substrate-agnostic — a "base" here is just a
 * directory + a stamped pointer; whether it is later materialized by `cp -a`
 * (today's nm-store) or an overlay `lowerdir` does not change any of this code.
 *
 * What it models (and therefore lets us decide):
 *   - the per-`(repo, runtime fingerprint)` scope key
 *   - the stamped `.shipit/.install-done` marker (source commit + runtime
 *     fingerprint + install command) and the skip decision
 *   - the publish **commit-ancestry compare-and-swap** under a short per-scope
 *     lock: advance iff the candidate strictly descends the current base
 *   - eligibility (exit-0, pre-user, source base == remote default commit)
 *   - the depth-cap-triggered **clean reinstall** (flatten == correctness reset)
 *
 * Ancestry decisions use a *real* git repo (execFileSync) so the
 * `git merge-base --is-ancestor` semantics the plan relies on are exercised
 * for real, not faked.
 *
 * NOT modeled here (needs a privileged host — see host-overlay-spike.sh):
 *   the actual overlayfs mount, copy-up, bind-mount of the merged dir, inotify.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Scope: (repo, runtime fingerprint)
// ---------------------------------------------------------------------------

/**
 * Runtime fingerprint — must describe ABI compatibility, not just a broad
 * language family, so a base with compiled native addons/wheels is never
 * reused across incompatible runtimes. This mirrors (and extends) the
 * existing `nm-store.ts:runtimeKey()` but is *not* lockfile detection.
 *
 * In production this would also fold in each relevant runtime's ABI tag
 * (Node native-module ABI, CPython implementation + major.minor / ABI tag,
 * etc). The prototype keeps the inputs explicit so scenarios can vary them.
 */
export interface RuntimeInputs {
  imageDigest: string;
  arch: string;
  libc: string;
  /** e.g. ["node22", "cp312"] — one tag per relevant compiled-extension runtime. */
  abiTags: string[];
}

export function runtimeFingerprint(r: RuntimeInputs): string {
  return [r.imageDigest, r.arch, r.libc, [...r.abiTags].sort().join(",")].join("|");
}

export interface Scope {
  repo: string;
  runtime: string;
}

export function scopeKey(s: Scope): string {
  return crypto
    .createHash("sha256")
    .update(s.repo)
    .update("\0")
    .update(s.runtime)
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Stamped install marker (.shipit/.install-done upgrade)
// ---------------------------------------------------------------------------

/**
 * The plan upgrades today's presence-only `.shipit/.install-done` marker into a
 * *stamped* marker. A session may skip `agent.install` only when all three
 * stamped fields match its current checkout + base scope. Any non-default
 * checkout/reset, or a source-commit mismatch, whiteouts the marker first.
 */
export interface InstallMarker {
  sourceCommit: string;
  runtime: string;
  installCommand: string;
}

export interface CheckoutState {
  sourceCommit: string;
  runtime: string;
  installCommand: string;
}

/** True only when the stamped marker exactly matches the current checkout. */
export function markerAllowsSkip(
  marker: InstallMarker | null,
  checkout: CheckoutState,
): boolean {
  if (!marker) return false;
  return (
    marker.sourceCommit === checkout.sourceCommit &&
    marker.runtime === checkout.runtime &&
    marker.installCommand === checkout.installCommand
  );
}

// ---------------------------------------------------------------------------
// Base pointer (one rolling base per scope)
// ---------------------------------------------------------------------------

export interface BasePointer {
  scope: Scope;
  /** The `main` commit this base was built from (the ordering key). */
  commit: string;
  /** Incremental installs stacked since the last clean rebuild (overlay depth). */
  depth: number;
  /** Generation counter — bumps on every advance AND every flatten. */
  generation: number;
  baseDir: string;
}

export interface PublishCandidate {
  scope: Scope;
  /** The `main` commit recorded at step 2 (git fast-forward), pre-install. */
  commit: string;
  /** Install process exit code. Only 0 may publish. */
  exitCode: number;
  /** True iff the install ran before any user/agent dependency edit. */
  preUserInstall: boolean;
  /** True iff the recorded source base is the remote default-branch commit. */
  sourceIsDefaultBranch: boolean;
  /** The merged tree this candidate produced (would become the next base). */
  mergedDir: string;
}

export type PublishOutcome =
  | "advanced" // strictly-forward commit, base moved forward (depth++)
  | "flattened" // forward commit but depth cap hit → clean rebuild from empty
  | "created" // first base for this scope (v0 from empty)
  | "skipped-equal" // candidate commit == base commit (deps already current)
  | "skipped-not-forward" // behind or diverged (e.g. force-push)
  | "skipped-ineligible"; // not exit-0 / not pre-user / source not default

export interface PublishResult {
  outcome: PublishOutcome;
  pointer: BasePointer | null;
}

/**
 * Config knob from §5 — depth cap is a *specific tunable value* (≈10–20),
 * deliberately well below the overlay hard limit, not the max itself.
 */
export const DEFAULT_DEPTH_CAP = 16;

// ---------------------------------------------------------------------------
// Per-scope lock (cross-process, mkdir-based — atomic on every POSIX fs)
// ---------------------------------------------------------------------------

/**
 * mkdir is atomic (EEXIST if present), so a lock *directory* is a zero-dep
 * cross-process mutex. The real implementation would likely use flock(2), but
 * the point of the prototype is to confirm the read-compare-swap window is
 * cheap and that a late-but-older publisher cannot clobber a newer base — both
 * hold regardless of lock primitive.
 */
export async function withScopeLock<T>(
  lockRoot: string,
  scope: Scope,
  fn: () => Promise<T> | T,
): Promise<T> {
  const lockDir = path.join(lockRoot, `${scopeKey(scope)}.lock`);
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      fs.mkdirSync(lockDir, { recursive: false });
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`lock timeout for ${scopeKey(scope)}`);
      await new Promise((r) => setTimeout(r, 2));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// git ancestry — the actual ordering decision
// ---------------------------------------------------------------------------

/** `git merge-base --is-ancestor a b` → true iff a is an ancestor of b. */
export function isAncestor(gitDir: string, a: string, b: string): boolean {
  try {
    execFileSync("git", ["-C", gitDir, "merge-base", "--is-ancestor", a, b], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Base pointer persistence (one JSON file per scope)
// ---------------------------------------------------------------------------

function pointerPath(stateRoot: string, scope: Scope): string {
  return path.join(stateRoot, `${scopeKey(scope)}.json`);
}

export function readPointer(stateRoot: string, scope: Scope): BasePointer | null {
  try {
    return JSON.parse(fs.readFileSync(pointerPath(stateRoot, scope), "utf8"));
  } catch {
    return null;
  }
}

function writePointer(stateRoot: string, p: BasePointer): void {
  fs.mkdirSync(stateRoot, { recursive: true });
  const tmp = pointerPath(stateRoot, p.scope) + `.tmp-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(p));
  fs.renameSync(tmp, pointerPath(stateRoot, p.scope)); // atomic swap
}

// ---------------------------------------------------------------------------
// The publish compare-and-swap
// ---------------------------------------------------------------------------

/**
 * Attempt to advance the scope's rolling base with `candidate`. The decision
 * is **commit ancestry, not wall-clock / lock-acquisition order**: a
 * late-but-older publisher reads the newer base under the lock and declines.
 *
 * `materializeBase(srcDir, destDir, fromEmpty)` is the substrate hook — copy
 * today, overlay-publish later. It returns the new base dir. `fromEmpty` is
 * true on the depth-cap flatten so the caller does a *clean reinstall* into an
 * empty tree rather than stacking another layer.
 */
export async function publishBase(args: {
  stateRoot: string;
  lockRoot: string;
  gitDir: string;
  candidate: PublishCandidate;
  depthCap?: number;
  materializeBase: (srcDir: string, fromEmpty: boolean) => string;
}): Promise<PublishResult> {
  const { stateRoot, lockRoot, gitDir, candidate } = args;
  const depthCap = args.depthCap ?? DEFAULT_DEPTH_CAP;

  // Eligibility is decided OUTSIDE the lock — it needs no shared state.
  if (
    candidate.exitCode !== 0 ||
    !candidate.preUserInstall ||
    !candidate.sourceIsDefaultBranch
  ) {
    return { outcome: "skipped-ineligible", pointer: readPointer(stateRoot, candidate.scope) };
  }

  return withScopeLock(lockRoot, candidate.scope, () => {
    const current = readPointer(stateRoot, candidate.scope);

    // First base for this scope → v0 from empty.
    if (!current) {
      const baseDir = args.materializeBase(candidate.mergedDir, true);
      const pointer: BasePointer = {
        scope: candidate.scope,
        commit: candidate.commit,
        depth: 1,
        generation: 1,
        baseDir,
      };
      writePointer(stateRoot, pointer);
      return { outcome: "created", pointer };
    }

    // Equal commit → deps already current, no-op.
    if (current.commit === candidate.commit) {
      return { outcome: "skipped-equal", pointer: current };
    }

    // Strictly-forward check. Behind OR diverged (force-push) → skip; the base
    // waits for the next genuinely-forward install. This is the CAS "loser".
    if (!isAncestor(gitDir, current.commit, candidate.commit)) {
      return { outcome: "skipped-not-forward", pointer: current };
    }

    // Forward. Either advance (depth++) or, at the cap, flatten via clean
    // reinstall from empty so every flatten is also a reproducibility reset.
    const wouldBeDepth = current.depth + 1;
    if (wouldBeDepth >= depthCap) {
      const baseDir = args.materializeBase(candidate.mergedDir, true);
      const pointer: BasePointer = {
        scope: candidate.scope,
        commit: candidate.commit,
        depth: 1,
        generation: current.generation + 1,
        baseDir,
      };
      writePointer(stateRoot, pointer);
      return { outcome: "flattened", pointer };
    }

    const baseDir = args.materializeBase(candidate.mergedDir, false);
    const pointer: BasePointer = {
      scope: candidate.scope,
      commit: candidate.commit,
      depth: wouldBeDepth,
      generation: current.generation + 1,
      baseDir,
    };
    writePointer(stateRoot, pointer);
    return { outcome: "advanced", pointer };
  });
}
