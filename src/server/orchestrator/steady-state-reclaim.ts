/**
 * Steady-state disk reclaim — the disk sweeps that grow with the CLOCK, not with
 * a crashed teardown. Split out of `startup-janitor.ts` (SHI-196) and run on the
 * periodic disk-tier escalation pass (`escalateDiskTiers`, fired at startup, after
 * each session activation, and on the hourly timer) rather than boot-only.
 *
 * Each sweep here accumulates as repos / worker-images / sessions come and go,
 * independent of whether any teardown failed:
 *   - **Orphan `repo-cache/<hash>` and `dep-cache/<hash>` directories** whose repo
 *     URL has no `repos` row or whose `last_used_at` is older than
 *     `DISK_JANITOR_CACHE_DAYS` (default 30). Grows as repos are added/abandoned.
 *   - **Orphan `repo-memory/<hash>` directories** (docs/155) — shared per-repo
 *     Claude memory keyed by the same repo hash. Same liveness rule as the caches;
 *     lives under `credentialsDir`, so it only runs when that dep is wired.
 *   - **Obsolete `overlay-base/<scope-hash>` dirs** (docs/183 Phase 2/3, SHI-193)
 *     reclaimed by a **deterministic live-mount check, not an age cutoff**. A base
 *     scope keys on `overlayRuntimeKey` (base-image digest + arch), so a worker-image
 *     rebuild rotates every scope hash — an old-image scope goes obsolete the instant
 *     the image rolls. A scope is reclaimable the moment it has zero live mounts:
 *     the union of (a) base generations pinned by a RUNNING session-worker container
 *     right now and (b) the bases every resumable session would re-pin for the CURRENT
 *     runtime (`liveOverlayScopeHashes`). Gated on a `liveOverlayScopeHashes` source;
 *     skipped entirely until that source is wired.
 *   - **Stale `pnpm-store/<hash>` dirs** (docs/197 Part 2) — one shared store per
 *     runtime fingerprint; a worker-image rebuild rotates the hash, leaving the
 *     prior runtime's store behind. Gated on a `pnpmStoreRuntimeHash` source.
 *
 * Why periodic (not boot-only): unlike the failure-recovery sweeps in
 * `runDiskJanitor` (orphan volumes/networks/workspaces/credentials/logs/branches —
 * which only exist if a teardown crashed and so do NOT accumulate steadily), these
 * grow with normal use. prod is deployed *manually*, so the orchestrator can run a
 * long time between restarts; a boot-only sweep would let these caches pile up
 * unreclaimed between deploys, and a wedged box (full disk → new starts fail) would
 * never reclaim at all. Riding the escalation pass — which is the one steady-state
 * disk trigger, already fired hourly + per-activation + on pressure — fixes both.
 *
 * Note the `dep-cache/<hash>/nm-store` reclaim (docs/183 Phase 1) deliberately stays
 * in `runDiskJanitor`: it's a one-time migration cleanup (the worker never writes
 * nm-store again), so it neither accumulates nor recovers from a crash — boot is the
 * natural place for a one-shot sweep.
 *
 * Behavior knobs (env vars):
 *   - DISK_JANITOR_CACHE_DAYS: age in days at which unreferenced `repo-cache/<hash>`,
 *     `dep-cache/<hash>`, `repo-memory/<hash>`, and stale `pnpm-store/<hash>` dirs are
 *     deleted. Default `30`.
 *   - The pace between destructive ops is wired by the caller (the escalation pass's
 *     `DISK_ESCALATION_PACE_MS`).
 */

import path from "node:path";
import fs from "node:fs/promises";
import type { RepoStore } from "./repo-store.js";
import { repoUrlToHash } from "./git-utils.js";
import { REPO_MEMORY_SUBDIR } from "./session-credentials.js";
import { OVERLAY_BASE_SUBDIR } from "./overlay-volume.js";
import { readBasePointerByHash } from "./overlay-base.js";
import { PNPM_STORE_SUBDIR } from "./overlay-session.js";
import { getMessage, sleep, defaultRunDocker } from "./disk-utils.js";

const DEFAULT_CACHE_DAYS = 30;

export interface SteadyStateReclaimDeps {
  /** Root that holds `repo-cache/<hash>`, `dep-cache/<hash>`, `overlay-base/<hash>`, `pnpm-store/<hash>`. */
  stateDir: string;
  repoStore: RepoStore;
  /** Age threshold (days) for unreferenced cache / memory / pnpm-store directories. */
  cacheDays?: number;
  /**
   * docs/138 / docs/155 — source-of-truth credentials root (e.g. `/credentials`).
   * When provided, the `repo-memory/<hash>` sweep runs. Omitted in tests / runtimes
   * without container credentials.
   */
  credentialsDir?: string;
  /**
   * Shell-out hook for docker commands (overlay live-mount check). Overridable for
   * tests so we never touch a real Docker daemon from unit tests.
   */
  runDocker?: (args: string[]) => Promise<string>;
  /**
   * docs/183 Phase 2/3, SHI-193 — overlay rolling-base GC, resumable-session half of
   * the liveness union. Returns the set of overlay-base scope-hashes that every
   * resumable session would re-pin for the CURRENT runtime on activation. The sweep
   * unions this with the generations a RUNNING container pins right now (resolved
   * internally via `docker volume inspect`) and removes every `overlay-base/<hash>/`
   * outside that union. MUST be provided before the sweep runs; the overlay-base
   * sweep is skipped when omitted. Returns an empty set under the `OVERLAY_DEP_STORE`
   * kill switch so the sweep stays inert when the feature is off.
   */
  liveOverlayScopeHashes?: () => Set<string>;
  /**
   * docs/197 Part 2 — pnpm shared-store GC. Returns the hash of the store dir for the
   * CURRENT runtime (the live store that must never be swept), or `null` when the
   * `OVERLAY_DEP_STORE=0`/`false` kill switch disables the feature — in which case no
   * store is live, so every `pnpm-store/<hash>` past `cacheDays` is reapable. The
   * sweep runs only when this dep is provided.
   */
  pnpmStoreRuntimeHash?: () => string | null;
  /**
   * Throttle: milliseconds to pause between each destructive operation so the reclaim
   * drips out rather than hammering the Docker daemon / fs that a concurrent agent
   * start also needs. Defaults to `0` (no pause) so unit tests stay fast.
   */
  paceMs?: number;
}

export interface SteadyStateReclaimResult {
  /** `repo-cache/<hash>` + `dep-cache/<hash>` dirs removed (unreferenced or past cutoff). */
  cachesRemoved: number;
  /** docs/155 — shared per-repo Claude memory dirs removed (unreferenced repo hash). */
  repoMemoryDirsRemoved: number;
  /** docs/183 Phase 2/3 — stale, unreferenced `overlay-base/<hash>` dirs removed. */
  overlayBasesRemoved: number;
  /** docs/197 Part 2 — stale `pnpm-store/<hash>` dirs removed (non-current runtime, past cutoff). */
  pnpmStoresRemoved: number;
}

/**
 * Run the steady-state disk reclaim once. Each sub-step is wrapped in try/catch so
 * one failing reclaim doesn't block the others. Always resolves — never rejects — so
 * callers can fire-and-forget from the escalation pass without needing a `.catch`.
 */
export async function runSteadyStateReclaim(
  deps: SteadyStateReclaimDeps,
): Promise<SteadyStateReclaimResult> {
  const result: SteadyStateReclaimResult = {
    cachesRemoved: 0,
    repoMemoryDirsRemoved: 0,
    overlayBasesRemoved: 0,
    pnpmStoresRemoved: 0,
  };
  const runDocker = deps.runDocker ?? defaultRunDocker;
  const paceMs = deps.paceMs ?? 0;
  const cacheDays = deps.cacheDays ?? DEFAULT_CACHE_DAYS;

  try {
    result.cachesRemoved = await sweepOrphanedCaches(
      deps.stateDir, deps.repoStore, cacheDays, paceMs,
    );
  } catch (err) {
    console.warn("[disk-janitor] cache sweep failed:", getMessage(err));
  }

  // docs/183 Phase 2/3, SHI-193 — sweep obsolete overlay bases via a deterministic
  // live-mount check (not an age cutoff). Gated on a live-scope-hash source: removing
  // a base dir that still backs a live overlay `lowerdir` is undefined behavior, so
  // without a way to confirm which bases are in use we don't touch the subtree at all.
  if (deps.liveOverlayScopeHashes) {
    try {
      result.overlayBasesRemoved = await sweepOrphanedOverlayBases(
        deps.stateDir,
        deps.liveOverlayScopeHashes(),
        runDocker,
        paceMs,
      );
    } catch (err) {
      console.warn("[disk-janitor] overlay-base sweep failed:", getMessage(err));
    }
  }

  // docs/197 Part 2 — sweep stale pnpm shared stores. Gated on a runtime-hash source
  // (mirrors the overlay-base gate): without a way to know which store is live, we
  // don't touch the subtree at all.
  if (deps.pnpmStoreRuntimeHash) {
    try {
      result.pnpmStoresRemoved = await sweepStalePnpmStores(
        deps.stateDir,
        deps.pnpmStoreRuntimeHash(),
        cacheDays,
        paceMs,
      );
    } catch (err) {
      console.warn("[disk-janitor] pnpm-store sweep failed:", getMessage(err));
    }
  }

  if (deps.credentialsDir) {
    try {
      result.repoMemoryDirsRemoved = await sweepOrphanedRepoMemory(
        deps.credentialsDir, deps.repoStore, cacheDays, paceMs,
      );
    } catch (err) {
      console.warn("[disk-janitor] repo-memory sweep failed:", getMessage(err));
    }
  }

  // Log only when something was reclaimed — this pass fires per-activation, so an
  // unconditional line would be noise (mirrors `escalateDiskTiers`).
  if (
    result.cachesRemoved || result.overlayBasesRemoved
    || result.pnpmStoresRemoved || result.repoMemoryDirsRemoved
  ) {
    console.log(
      `[disk-janitor] steady-state reclaim: caches=${result.cachesRemoved} `
      + `overlay-bases=${result.overlayBasesRemoved} `
      + `pnpm-stores=${result.pnpmStoresRemoved} `
      + `repo-memory=${result.repoMemoryDirsRemoved}`,
    );
  }
  return result;
}

/**
 * docs/155 — remove shared per-repo Claude memory dirs under
 * `<credentialsDir>/repo-memory/<repoHash>` whose repo hash is no longer
 * referenced by a recently-used repo. Keyed exactly like
 * {@link sweepOrphanedCaches}: a hash is "live" iff some `repos` row resolves to
 * it AND that repo's `lastUsedAt` is within `days`. An orphaned memory dir is
 * one whose repo was removed or has gone untouched past the cutoff.
 *
 * Memory is regeneratable accumulation, not the only copy of anything, so this
 * is safe to do without coordinating with live sessions — same posture as the
 * cache sweep. Returns the count of memory dirs removed.
 */
async function sweepOrphanedRepoMemory(
  credentialsDir: string,
  repoStore: RepoStore,
  days: number,
  paceMs: number,
): Promise<number> {
  const cutoffMs = Date.now() - days * 86_400_000;
  const liveHashes = new Set<string>();
  for (const repo of repoStore.list()) {
    const lastUsedMs = Date.parse(repo.lastUsedAt);
    if (Number.isFinite(lastUsedMs) && lastUsedMs >= cutoffMs) {
      liveHashes.add(repoUrlToHash(repo.url));
    }
  }

  const dir = path.join(credentialsDir, REPO_MEMORY_SUBDIR);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0; // No repo-memory subtree yet — nothing to sweep.
  }

  let removed = 0;
  for (const entry of entries) {
    if (liveHashes.has(entry)) continue;
    const full = path.join(dir, entry);
    try {
      await sleep(paceMs);
      await fs.rm(full, { recursive: true, force: true });
      removed += 1;
      console.log(`[disk-janitor] removed orphan repo-memory ${full}`);
    } catch (err) {
      console.warn(`[disk-janitor] failed to remove ${full}:`, getMessage(err));
    }
  }
  return removed;
}

/**
 * Remove `repo-cache/<hash>` and `dep-cache/<hash>` directories whose hash
 * doesn't appear in the active repos table OR whose repo `lastUsedAt` is
 * older than `days`. Bare clones / dep caches can always be recreated, so
 * this is safe to do without coordinating with active sessions.
 */
async function sweepOrphanedCaches(
  stateDir: string,
  repoStore: RepoStore,
  days: number,
  paceMs: number,
): Promise<number> {
  const cutoffMs = Date.now() - days * 86_400_000;
  const repos = repoStore.list();
  const liveHashes = new Set<string>();
  for (const repo of repos) {
    const lastUsedMs = Date.parse(repo.lastUsedAt);
    if (Number.isFinite(lastUsedMs) && lastUsedMs >= cutoffMs) {
      liveHashes.add(repoUrlToHash(repo.url));
    }
  }

  let removed = 0;
  for (const subdir of ["repo-cache", "dep-cache"]) {
    const dir = path.join(stateDir, subdir);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (liveHashes.has(entry)) continue;
      const full = path.join(dir, entry);
      try {
        await sleep(paceMs);
        await fs.rm(full, { recursive: true, force: true });
        removed += 1;
        console.log(`[disk-janitor] removed orphan cache ${full}`);
      } catch (err) {
        console.warn(`[disk-janitor] failed to remove ${full}:`, getMessage(err));
      }
    }
  }
  return removed;
}

/**
 * Crash-orphaned `.tmp-*` materialize copies (left by a publish that died after
 * the copy but before the rename) are never overlay-mounted, so the live-mount
 * check can't speak to them. But a publish running concurrently with the sweep is
 * mid-write into one — so they get a short fixed grace window (well above any
 * publish's wall-clock, far below the obsolete 30-day cutoff) instead of an
 * immediate delete. This is the ONLY age guard left in the overlay-base sweep.
 */
const OVERLAY_TMP_GRACE_MS = 60 * 60 * 1000; // 1 hour

/**
 * docs/183 Phase 2/3, SHI-193 — reclaim obsolete overlay bases under
 * `<stateDir>/overlay-base/<scope-hash>/` via a **deterministic live-mount check**,
 * not an age cutoff.
 *
 * A base scope keys on `overlayRuntimeKey` (base-image digest + arch), so a
 * worker-image rebuild rotates every scope hash — an old-image scope is obsolete
 * the instant the image rolls, because no future container can mount it (new
 * containers compute the new scope hash). The 30-day age proxy this replaced
 * therefore over-retained badly (measured: 46 of 47 prod scope dirs, ~26 GB, were
 * dead old-image scopes a 30-day window kept alive) and was unsafe at the boundary
 * (a 31-day-old scope could in principle still be mounted). The live-mount check is
 * exact in both directions.
 *
 * A scope is reclaimable the moment it has ZERO live mounts. "Live" is the union of:
 *
 *   1. **Running-container mounts** — the base generations a RUNNING session-worker
 *      container pins as its overlay `lowerdir` right now, read from
 *      `docker volume inspect` (`liveMountedOverlayBaseGenerations`). This is the
 *      authoritative signal and the ONLY thing that can pin an old-runtime base —
 *      e.g. a container created under the old image still running mid-turn when a
 *      new image deploys. Its base stays pinned until it exits, then drops.
 *   2. **Resumable-session bases** — `resumableScopeHashes`, the CURRENT-runtime
 *      bases every idle (non-evicted) session would re-pin on activation. Covers
 *      sessions whose containers aren't running now, so there's no mount to observe.
 *
 * Any `overlay-base/<hash>/` whose scope-hash is in neither set is removed
 * immediately. For a scope that IS live, the scope dir is kept and only its
 * superseded generations are reaped — see `sweepStaleBaseGenerations`.
 *
 * The repo-url `liveHashes` set used by `sweepOrphanedCaches` is deliberately NOT
 * reused: an overlay-base scope-hash keys on `(repo, runtime fingerprint, dep-dir)`,
 * so it never appears in a repo-url-keyed set — a naive extension would delete every
 * live base on the first run.
 *
 * If the docker queries fail, `liveMountedOverlayBaseGenerations` returns an empty
 * set: the sweep then relies solely on `resumableScopeHashes`, which still protects
 * every current-runtime base. The only thing lost on a docker failure is the
 * protection for an old-runtime base of a still-running old-image container — and
 * the sweep is fire-and-forget, retried next pass, so a transient failure just
 * defers that one reclaim.
 */
async function sweepOrphanedOverlayBases(
  stateDir: string,
  resumableScopeHashes: Set<string>,
  runDocker: (args: string[]) => Promise<string>,
  paceMs: number,
): Promise<number> {
  const dir = path.join(stateDir, OVERLAY_BASE_SUBDIR);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0; // No overlay-base subtree yet — nothing to sweep.
  }

  // The exact `<hash>/g<N>` generations a running container pins right now, and the
  // scope hashes derived from them — unioned with the resumable-session bases.
  const liveGenKeys = await liveMountedOverlayBaseGenerations(runDocker);
  const liveScopeHashes = new Set(resumableScopeHashes);
  for (const key of liveGenKeys) liveScopeHashes.add(key.split("/")[0]);

  let removed = 0;
  for (const entry of entries) {
    if (liveScopeHashes.has(entry)) {
      // Live scope — never remove the scope dir, but reap its superseded
      // generations (bases are immutable `g<N>` children: each publish creates
      // the next generation and moves the pointer, so old ones accumulate).
      removed += await sweepStaleBaseGenerations(
        stateDir, path.join(dir, entry), entry, liveGenKeys, paceMs,
      );
      continue;
    }
    const full = path.join(dir, entry);
    try {
      // lstat, not stat: a symlink named like a scope-hash must never be treated
      // as a base dir (and never have its target followed).
      const st = await fs.lstat(full);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    try {
      await sleep(paceMs);
      await fs.rm(full, { recursive: true, force: true });
      removed += 1;
      console.log(`[disk-janitor] removed obsolete overlay base ${full} (no live mount)`);
    } catch (err) {
      console.warn(`[disk-janitor] failed to remove ${full}:`, getMessage(err));
    }
  }
  return removed;
}

/**
 * Reap superseded generations inside one LIVE scope dir, via the live-mount check
 * (SHI-193). A `g<N>` child is removed UNLESS it is one of:
 *   - `g0` — the empty cold-start lowerdir; cold mounts pin it and it costs nothing.
 *   - the pointer's current generation — the base a fresh/resuming session mounts.
 *   - a generation in `liveGenKeys` — pinned as a `lowerdir` by a running container
 *     right now (e.g. a container created before the last publish advanced the
 *     pointer; it keeps mounting the older generation until it exits).
 * Everything else has no live mount and is reclaimable immediately — no age delay.
 * Crash-orphaned `.tmp-*` copies get the short `OVERLAY_TMP_GRACE_MS` window instead
 * (they're never mounted, but an in-flight publish may be writing one).
 */
async function sweepStaleBaseGenerations(
  stateDir: string,
  scopeDir: string,
  scopeHash: string,
  liveGenKeys: Set<string>,
  paceMs: number,
): Promise<number> {
  let children: string[];
  try {
    children = await fs.readdir(scopeDir);
  } catch {
    return 0;
  }
  const currentGen = readBasePointerByHash(stateDir, scopeHash)?.generation ?? null;
  const tmpCutoffMs = Date.now() - OVERLAY_TMP_GRACE_MS;

  let removed = 0;
  for (const child of children) {
    const isTmp = child.startsWith(".tmp-");
    const genMatch = /^g(\d+)$/.exec(child);
    if (!isTmp && !genMatch) continue; // unknown entry — never touch.
    const full = path.join(scopeDir, child);
    if (genMatch) {
      const gen = Number(genMatch[1]);
      if (gen === 0) continue; // empty cold-start lowerdir — always kept.
      if (currentGen !== null && gen === currentGen) continue; // current base.
      if (liveGenKeys.has(`${scopeHash}/g${gen}`)) continue; // pinned by a running container.
    }
    try {
      const st = await fs.lstat(full);
      if (!st.isDirectory()) continue;
      // `.tmp-*` crash orphans: never mounted, but guard against racing an
      // in-flight publish with a short grace window (the lone age guard left).
      if (isTmp && st.mtimeMs >= tmpCutoffMs) continue;
    } catch {
      continue;
    }
    try {
      await sleep(paceMs);
      await fs.rm(full, { recursive: true, force: true });
      removed += 1;
      console.log(`[disk-janitor] removed stale overlay base generation ${full}`);
    } catch (err) {
      console.warn(`[disk-janitor] failed to remove ${full}:`, getMessage(err));
    }
  }
  return removed;
}

/**
 * SHI-193 — enumerate the overlay base generations currently pinned as a
 * `lowerdir` by a RUNNING session-worker container. This is the deterministic
 * "is this base live?" signal that replaces the old 30-day age proxy.
 *
 * Mechanism (exactly the issue's recipe): list running containers, read their
 * mounted overlay volume names (`shipit-<id12>_overlay…`), then
 * `docker volume inspect … {{.Options.o}}` each to recover the
 * `lowerdir=…/overlay-base/<hash>/g<N>` its driver option encodes.
 *
 * We gate on RUNNING containers, NOT "the volume exists on disk": an idle
 * (non-evicted) session keeps its overlay volume for a warm resume, but on resume
 * `createOverlayVolume` removes+recreates it against the CURRENT-runtime base — so
 * a lingering idle volume never re-pins its (possibly old-runtime) lowerdir and
 * must not keep an obsolete scope alive. Idle sessions' current-runtime bases are
 * covered by the resumable-session union in the caller.
 *
 * Returns a set of `<hash>/g<N>` keys (one per mounted base generation). Any docker
 * failure resolves to an empty set; the caller treats that conservatively (it still
 * protects current-runtime bases via the resumable-session union).
 */
async function liveMountedOverlayBaseGenerations(
  runDocker: (args: string[]) => Promise<string>,
): Promise<Set<string>> {
  const keys = new Set<string>();

  let psOut: string;
  try {
    psOut = await runDocker(["ps", "-q"]);
  } catch (err) {
    console.warn("[disk-janitor] docker ps failed (overlay live-mount check):", getMessage(err));
    return keys;
  }
  const ids = psOut.split("\n").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return keys;

  let inspectOut: string;
  try {
    inspectOut = await runDocker([
      "container", "inspect",
      "--format", "{{range .Mounts}}{{println .Name}}{{end}}",
      ...ids,
    ]);
  } catch (err) {
    console.warn(
      "[disk-janitor] docker container inspect failed (overlay live-mount check):",
      getMessage(err),
    );
    return keys;
  }
  // Overlay volume names match the per-session pattern (overlay-volume.ts); only
  // session-worker agent containers mount them, so this filter selects exactly
  // the live overlay mounts without needing a label filter on `docker ps`.
  const OVERLAY_VOL_RE = /^shipit-[a-f0-9-]{12}_overlay/;
  const volNames = new Set(
    inspectOut.split("\n").map((s) => s.trim()).filter((n) => OVERLAY_VOL_RE.test(n)),
  );
  if (volNames.size === 0) return keys;

  let volOut: string;
  try {
    volOut = await runDocker([
      "volume", "inspect",
      "--format", "{{.Options.o}}",
      ...volNames,
    ]);
  } catch (err) {
    console.warn(
      "[disk-janitor] docker volume inspect failed (overlay live-mount check):",
      getMessage(err),
    );
    return keys;
  }
  // `o` is `lowerdir=…/overlay-base/<hash>/g<N>,upperdir=…,workdir=…`. The scope
  // hash (16 hex) + generation appear only in the `overlay-base/` lowerdir segment;
  // the upper/work dirs live under `sessions/<id>/overlay/`, never `overlay-base/`.
  const GEN_RE = /overlay-base\/([0-9a-f]{16})\/g(\d+)/g;
  for (const line of volOut.split("\n")) {
    GEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = GEN_RE.exec(line)) !== null) {
      keys.add(`${m[1]}/g${m[2]}`);
    }
  }
  return keys;
}

/**
 * docs/197 Part 2 — reclaim stale pnpm shared stores under
 * `<stateDir>/pnpm-store/<runtimeKey-hash>/`.
 *
 * One store per runtime fingerprint; a worker-image rebuild rotates the hash, so
 * the previous runtime's store is left behind. A dir is removed only when BOTH:
 *
 *   1. Its hash is NOT `liveHash` (the current runtime's store, or null when the
 *      feature is off — then nothing is live and every store is a candidate). The
 *      live store is never swept; a session installing into it right now must keep
 *      its hardlink targets.
 *   2. Its mtime is older than `days` — the same age guard the other cache sweeps
 *      use, so a store still in active use by a resuming session of the prior
 *      runtime (recently touched) survives until it has genuinely gone cold.
 *
 * Unlike the overlay base, a pnpm store is a pure content-addressed cache: dropping
 * it costs only a re-fetch+relink on the next install, never user data. Lazily
 * recreated on the next pnpm session for that runtime.
 */
async function sweepStalePnpmStores(
  stateDir: string,
  liveHash: string | null,
  days: number,
  paceMs: number,
): Promise<number> {
  const cutoffMs = Date.now() - days * 86_400_000;
  const dir = path.join(stateDir, PNPM_STORE_SUBDIR);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0; // No pnpm-store subtree yet — nothing to sweep.
  }

  let removed = 0;
  for (const entry of entries) {
    if (liveHash !== null && entry === liveHash) continue; // live store — never sweep.
    const full = path.join(dir, entry);
    let mtimeMs: number;
    try {
      // lstat, not stat: a symlink named like a store hash must never be followed.
      const st = await fs.lstat(full);
      if (!st.isDirectory()) continue;
      mtimeMs = st.mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs >= cutoffMs) continue; // recently touched — keep (a resume may use it).
    try {
      await sleep(paceMs);
      await fs.rm(full, { recursive: true, force: true });
      removed += 1;
      console.log(`[disk-janitor] removed stale pnpm store ${full}`);
    } catch (err) {
      console.warn(`[disk-janitor] failed to remove ${full}:`, getMessage(err));
    }
  }
  return removed;
}
