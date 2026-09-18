// Periodic cache reclaim; failed-teardown recovery remains in startup-janitor.ts.
import path from "node:path";
import fs from "node:fs/promises";
import type { RepoStore } from "./repo-store.js";
import { repoUrlToHash } from "./git-utils.js";
import { REPO_MEMORY_SUBDIR } from "./session-credentials.js";
import { OVERLAY_BASE_SUBDIR } from "./overlay-volume.js";
import { readBasePointerByHash } from "./overlay-base.js";
import { liveOverlayBaseClaims } from "./overlay-base-claims.js";
import { PNPM_STORE_SUBDIR } from "./overlay-session.js";
import { getMessage, sleep, defaultRunDocker } from "./disk-utils.js";

const DEFAULT_CACHE_DAYS = 30;
const DEFAULT_LFS_OBJECT_DAYS = 14;
const LFS_OBJECT_DAYS_ENV = "DISK_JANITOR_LFS_OBJECT_DAYS";

export interface SteadyStateReclaimDeps {
  stateDir: string;
  repoStore: RepoStore;
  cacheDays?: number;
  lfsObjectDays?: number;
  credentialsDir?: string;
  runDocker?: (args: string[]) => Promise<string>;
  /** Current-runtime scopes resumable sessions would mount; omission skips overlay reclaim. */
  liveOverlayScopeHashes?: () => Set<string>;
  /** Null permits reclaim of every cold store; omission skips the sweep. */
  pnpmStoreRuntimeHash?: () => string | null;
  /** Plugin artifacts are not represented by repoStore or session dep-dir scopes. */
  livePluginStoreArtifacts?: () => Promise<{ scopeHashes: Set<string>; cacheHashes: Set<string> }>;
  paceMs?: number;
}

export interface SteadyStateReclaimResult {
  cachesRemoved: number;
  repoMemoryDirsRemoved: number;
  overlayBasesRemoved: number;
  pnpmStoresRemoved: number;
  lfsObjectsRemoved: number;
  lfsBytesFreed: number;
}

export async function runSteadyStateReclaim(
  deps: SteadyStateReclaimDeps,
): Promise<SteadyStateReclaimResult> {
  const result: SteadyStateReclaimResult = {
    cachesRemoved: 0,
    repoMemoryDirsRemoved: 0,
    overlayBasesRemoved: 0,
    pnpmStoresRemoved: 0,
    lfsObjectsRemoved: 0,
    lfsBytesFreed: 0,
  };
  const runDocker = deps.runDocker ?? defaultRunDocker;
  const paceMs = deps.paceMs ?? 0;
  const cacheDays = deps.cacheDays ?? DEFAULT_CACHE_DAYS;

  let pluginLive: { scopeHashes: Set<string>; cacheHashes: Set<string> } | null = null;
  let pluginLiveFailed = false;
  if (deps.livePluginStoreArtifacts) {
    try {
      pluginLive = await deps.livePluginStoreArtifacts();
    } catch (err) {
      // Missing liveness must not be treated as proof that no plugin uses a base.
      pluginLiveFailed = true;
      console.warn("[disk-janitor] could not resolve live plugin dependency artifacts:", getMessage(err));
    }
  }

  if (pluginLiveFailed) {
    console.warn("[disk-janitor] skipping the cache and overlay-base sweeps this pass");
  } else {
    try {
      result.cachesRemoved = await sweepOrphanedCaches(
        deps.stateDir, deps.repoStore, cacheDays, paceMs, pluginLive?.cacheHashes,
      );
    } catch (err) {
      console.warn("[disk-janitor] cache sweep failed:", getMessage(err));
    }
  }

  if (deps.liveOverlayScopeHashes && !pluginLiveFailed) {
    try {
      result.overlayBasesRemoved = await sweepOrphanedOverlayBases(
        deps.stateDir,
        new Set([...deps.liveOverlayScopeHashes(), ...(pluginLive?.scopeHashes ?? [])]),
        runDocker,
        paceMs,
      );
    } catch (err) {
      console.warn("[disk-janitor] overlay-base sweep failed:", getMessage(err));
    }
  }

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

  // Reclaim old shared objects even if LFS sharing has since been disabled.
  try {
    const lfs = await sweepCacheLfsObjects(deps.stateDir, lfsObjectDays(deps), paceMs);
    result.lfsObjectsRemoved = lfs.removed;
    result.lfsBytesFreed = lfs.bytesFreed;
  } catch (err) {
    console.warn("[disk-janitor] cache LFS object sweep failed:", getMessage(err));
  }

  if (
    result.cachesRemoved || result.overlayBasesRemoved
    || result.pnpmStoresRemoved || result.repoMemoryDirsRemoved
    || result.lfsObjectsRemoved
  ) {
    console.log(
      `[disk-janitor] steady-state reclaim: caches=${result.cachesRemoved} `
      + `overlay-bases=${result.overlayBasesRemoved} `
      + `pnpm-stores=${result.pnpmStoresRemoved} `
      + `repo-memory=${result.repoMemoryDirsRemoved} `
      + `lfs-objects=${result.lfsObjectsRemoved} `
      + `(${Math.round(result.lfsBytesFreed / 1_048_576)} MiB)`,
    );
  }
  return result;
}

function lfsObjectDays(deps: SteadyStateReclaimDeps): number {
  if (deps.lfsObjectDays !== undefined) return deps.lfsObjectDays;
  const raw = Number(process.env[LFS_OBJECT_DAYS_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LFS_OBJECT_DAYS;
}

async function sweepCacheLfsObjects(
  stateDir: string,
  days: number,
  paceMs: number,
): Promise<{ removed: number; bytesFreed: number }> {
  const cacheRoot = path.join(stateDir, "repo-cache");
  let entries;
  try {
    entries = await fs.readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return { removed: 0, bytesFreed: 0 };
  }
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  let bytesFreed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const objectsDir = path.join(cacheRoot, entry.name, "lfs", "objects");
    const swept = await pruneLfsObjectTree(objectsDir, cutoffMs);
    removed += swept.removed;
    bytesFreed += swept.bytesFreed;
    // Pace per repository; a delay per object would make large stores take minutes.
    if (paceMs > 0 && swept.removed > 0) await sleep(paceMs);
  }
  return { removed, bytesFreed };
}

async function pruneLfsObjectTree(
  dir: string,
  cutoffMs: number,
): Promise<{ removed: number; bytesFreed: number; emptied: boolean }> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { removed: 0, bytesFreed: 0, emptied: false };
  }
  let removed = 0;
  let bytesFreed = 0;
  let survivors = 0;
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const swept = await pruneLfsObjectTree(child, cutoffMs);
      removed += swept.removed;
      bytesFreed += swept.bytesFreed;
      if (swept.emptied) {
        try {
          await fs.rmdir(child);
        } catch {
          survivors++;
        }
      } else {
        survivors++;
      }
      continue;
    }
    if (!entry.isFile()) {
      survivors++;
      continue;
    }
    try {
      const stat = await fs.lstat(child);
      // Another hardlink keeps the bytes live, so removing the cache link frees nothing.
      if (stat.nlink > 1 || stat.mtimeMs >= cutoffMs) {
        survivors++;
        continue;
      }
      await fs.unlink(child);
      removed++;
      bytesFreed += stat.size;
    } catch {
      survivors++;
    }
  }
  return { removed, bytesFreed, emptied: survivors === 0 };
}

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
    return 0;
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

async function sweepOrphanedCaches(
  stateDir: string,
  repoStore: RepoStore,
  days: number,
  paceMs: number,
  extraLiveCacheHashes?: ReadonlySet<string>,
): Promise<number> {
  const cutoffMs = Date.now() - days * 86_400_000;
  const repos = repoStore.list();
  const liveHashes = new Set<string>(extraLiveCacheHashes ?? []);
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

// Temporary publish copies are not mounted; allow time for an active publish to finish.
const OVERLAY_TMP_GRACE_MS = 60 * 60 * 1000;

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
    return 0;
  }

  const live = await liveMountedOverlayBaseGenerations(runDocker);
  if (!live.complete) {
    // Resumable scopes alone cannot protect superseded generations still mounted by containers.
    console.warn(
      "[disk-janitor] overlay live-mount check incomplete — skipping the overlay-base sweep this pass",
    );
    return 0;
  }
  // Claims protect generations selected for containers not yet visible in docker ps.
  const liveGenKeys = live.keys;
  for (const key of liveOverlayBaseClaims()) liveGenKeys.add(key);
  const liveScopeHashes = new Set(resumableScopeHashes);
  for (const key of liveGenKeys) liveScopeHashes.add(key.split("/")[0]);

  let removed = 0;
  for (const entry of entries) {
    if (liveScopeHashes.has(entry)) {
      removed += await sweepStaleBaseGenerations(
        stateDir, path.join(dir, entry), entry, liveGenKeys, paceMs,
      );
      continue;
    }
    const full = path.join(dir, entry);
    try {
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
    if (!isTmp && !genMatch) continue;
    const full = path.join(scopeDir, child);
    if (genMatch) {
      const gen = Number(genMatch[1]);
      if (gen === 0) continue;
      if (currentGen !== null && gen === currentGen) continue;
      if (liveGenKeys.has(`${scopeHash}/g${gen}`)) continue;
    }
    try {
      const st = await fs.lstat(full);
      if (!st.isDirectory()) continue;
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

interface LiveOverlayMounts {
  keys: Set<string>;
  // False means keys is only a lower bound, never evidence for deletion.
  complete: boolean;
}

const DOCKER_VANISHED_RE = /no such (container|volume|object)/i;

// A vanished target fails the whole batch. Retry individually instead of parsing partial error output.
async function inspectTolerantOfVanished(
  runDocker: (args: string[]) => Promise<string>,
  baseArgs: string[],
  names: string[],
  kind: string,
): Promise<{ out: string; complete: boolean }> {
  try {
    return { out: await runDocker([...baseArgs, ...names]), complete: true };
  } catch (err) {
    console.warn(
      `[disk-janitor] batched docker ${kind} inspect failed (overlay live-mount check),` +
      " re-reading individually:",
      getMessage(err),
    );
  }
  const lines: string[] = [];
  let complete = true;
  for (const name of names) {
    try {
      lines.push(await runDocker([...baseArgs, name]));
    } catch (err) {
      const message = getMessage(err);
      if (DOCKER_VANISHED_RE.test(message)) continue;
      console.warn(`[disk-janitor] docker ${kind} inspect failed for ${name}:`, message);
      complete = false;
    }
  }
  return { out: lines.join("\n"), complete };
}

// Idle volumes do not pin old generations: creation must repoint them before mounting.
async function liveMountedOverlayBaseGenerations(
  runDocker: (args: string[]) => Promise<string>,
): Promise<LiveOverlayMounts> {
  const keys = new Set<string>();

  let psOut: string;
  try {
    psOut = await runDocker(["ps", "-q"]);
  } catch (err) {
    console.warn("[disk-janitor] docker ps failed (overlay live-mount check):", getMessage(err));
    return { keys, complete: false };
  }
  const ids = psOut.split("\n").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return { keys, complete: true };

  const mounts = await inspectTolerantOfVanished(
    runDocker,
    ["container", "inspect", "--format", "{{range .Mounts}}{{println .Name}}{{end}}"],
    ids,
    "container",
  );
  const OVERLAY_VOL_RE = /^shipit-[a-f0-9-]{12}_overlay/;
  const volNames = new Set(
    mounts.out.split("\n").map((s) => s.trim()).filter((n) => OVERLAY_VOL_RE.test(n)),
  );
  if (volNames.size === 0) return { keys, complete: mounts.complete };

  const vols = await inspectTolerantOfVanished(
    runDocker,
    ["volume", "inspect", "--format", "{{.Options.o}}"],
    [...volNames],
    "volume",
  );
  // Only lowerdir uses overlay-base/; upperdir and workdir live under sessions/.
  const GEN_RE = /overlay-base\/([0-9a-f]{16})\/g(\d+)/g;
  for (const line of vols.out.split("\n")) {
    GEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = GEN_RE.exec(line)) !== null) {
      keys.add(`${m[1]}/g${m[2]}`);
    }
  }
  return { keys, complete: mounts.complete && vols.complete };
}

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
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (liveHash !== null && entry === liveHash) continue;
    const full = path.join(dir, entry);
    let mtimeMs: number;
    try {
      const st = await fs.lstat(full);
      if (!st.isDirectory()) continue;
      mtimeMs = st.mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs >= cutoffMs) continue;
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
