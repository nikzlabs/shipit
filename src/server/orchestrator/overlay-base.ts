import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import { overlayBaseGenDir, overlayScopeHash } from "./overlay-volume.js";
import { shareTreeWithAllSessions } from "./session-worker-uid.js";

export interface OverlayScope {
  repoUrl: string;
  runtimeKey: string;
  depDir?: string;
}

export interface BasePointer {
  scopeHash: string;
  // Newest default-branch commit whose dependency content this generation holds.
  commit: string;
  depth: number;
  generation: number;
  baseDir: string;
  updatedAt: string;
  // Worker runtime fingerprint, which differs from the orchestrator's scope key.
  marker?: { runtimeKey: string; installCommands: string[]; depsHash?: string | null };
}

export interface PublishCandidate {
  commit: string;
  exitCode: number;
  preUserInstall: boolean;
  sourceIsDefaultBranch: boolean;
  // Export the merged tree, not just the upperdir, or unchanged lowerdir dependencies vanish.
  snapshotDir: string;
  markerStamp?: { runtimeKey: string; installCommands: string[]; depsHash?: string | null };
  // Lifecycle scripts can change output without changing the dependency hash. Reuse needs caller approval.
  contentKeyDescribesTree?: boolean;
}

export type PublishOutcome =
  | "created"
  | "advanced"
  | "lineage-advanced"
  | "flattened"
  | "reset"
  | "skipped-equal"
  | "skipped-not-forward"
  | "skipped-ineligible";

export interface PublishResult {
  outcome: PublishOutcome;
  pointer: BasePointer | null;
}

export type IsAncestorFn = (ancestor: string, descendant: string) => Promise<boolean>;

export type MaterializeFn = (
  snapshotDir: string,
  scopeHash: string,
  generation: number,
  linkDedupBaseDir?: string,
) => Promise<string>;

export const DEFAULT_DEPTH_CAP = 16;

// Keep pointers out of mounted base contents and out of the directory swept as base scopes.
export const OVERLAY_POINTER_SUBDIR = "overlay-base-meta";

function pointerPath(stateDir: string, scopeHash: string): string {
  return path.join(stateDir, OVERLAY_POINTER_SUBDIR, `${scopeHash}.json`);
}

export function readBasePointer(stateDir: string, scope: OverlayScope): BasePointer | null {
  return readBasePointerByHash(stateDir, scopeHashOf(scope));
}

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
  fsSync.renameSync(tmp, final);
}

function scopeHashOf(scope: OverlayScope): string {
  return overlayScopeHash(scope.repoUrl, scope.runtimeKey, scope.depDir);
}

// One orchestrator owns all publishes; serialize each scope through materialization and pointer swap.
const scopeLocks = new Map<string, Promise<void>>();

async function withScopeLock<T>(scopeHash: string, fn: () => Promise<T>): Promise<T> {
  const prev = scopeLocks.get(scopeHash) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  scopeLocks.set(scopeHash, (async () => {
    try {
      await prev;
    } catch {
      /* A prior holder's failure must not poison the queue. */
    }
    await gate;
  })());
  try {
    await prev;
  } catch {
    // A prior holder's failure must not block this publish.
  }
  const tail = scopeLocks.get(scopeHash);
  try {
    return await fn();
  } finally {
    release();
    if (scopeLocks.get(scopeHash) === tail) scopeLocks.delete(scopeHash);
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.lstat(p)).isDirectory();
  } catch {
    return false;
  }
}

// Compare bytes: npm normalizes mtimes, so equal size and mtime do not prove equal content.
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
          /* Fall back to copying. */
        }
      }
      await fs.copyFile(src, dst, fsSync.constants.COPYFILE_FICLONE);
    } else {
      await fs.cp(src, dst, { recursive: true, verbatimSymlinks: true });
    }
  }
}

async function canHardlink(srcFile: string, linkFile: string): Promise<boolean> {
  let prev;
  try {
    prev = await fs.lstat(linkFile);
  } catch {
    return false;
  }
  if (!prev.isFile()) return false;
  const cur = await fs.lstat(srcFile);
  if (prev.size !== cur.size) return false;
  if ((prev.mode & 0o7777) !== (cur.mode & 0o7777)) return false;
  return filesContentEqual(srcFile, linkFile);
}

// Never replace a published generation: unlinking a mounted lowerdir breaks merged readdir.
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

  // Normalize modes before comparing; otherwise the shared group's write bits defeat hardlink reuse.
  shareTreeWithAllSessions(snapshotDir);

  const rand = crypto.randomBytes(4).toString("hex");
  const tmp = path.join(scopeDir, `.tmp-g${generation}-${rand}`);
  try {
    if (linkDedupBaseDir && (await isDirectory(linkDedupBaseDir))) {
      await materializeWithLinkDedup(snapshotDir, tmp, linkDedupBaseDir);
    } else {
      await fs.cp(snapshotDir, tmp, { recursive: true, verbatimSymlinks: true });
    }
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  // A leftover next generation was never published; remove a failed attempt before renaming.
  await fs.rm(genDir, { recursive: true, force: true }).catch(() => {});
  await fs.rename(tmp, genDir);

  const now = new Date();
  await fs.utimes(scopeDir, now, now).catch(() => {
    // Creating the child already updates the directory mtime.
  });
  return genDir;
}

function isContentEqualPublish(current: BasePointer, candidate: PublishCandidate): boolean {
  if (!candidate.contentKeyDescribesTree) return false;
  const have = current.marker;
  const want = candidate.markerStamp;
  if (!have || !want) return false;
  if (typeof have.depsHash !== "string" || typeof want.depsHash !== "string") return false;
  if (have.depsHash !== want.depsHash) return false;
  if (have.runtimeKey !== want.runtimeKey) return false;
  const a = have.installCommands;
  const b = want.installCommands;
  return a.length === b.length && a.every((cmd, i) => cmd === b[i]);
}

// Advance ordering even when content is unchanged, so a late older candidate cannot publish.
function advanceLineageOnly(stateDir: string, current: BasePointer, candidate: PublishCandidate): PublishResult {
  const pointer: BasePointer = {
    ...current,
    commit: candidate.commit,
    updatedAt: new Date().toISOString(),
  };
  writeBasePointer(stateDir, pointer);
  return { outcome: "lineage-advanced", pointer };
}

export interface PublishBaseArgs {
  stateDir: string;
  scope: OverlayScope;
  candidate: PublishCandidate;
  isAncestor: IsAncestorFn;
  // Divergence permits a reset only when this still matches the candidate; install-time status is stale.
  currentDefaultCommit?: string;
  depthCap?: number;
  materialize?: MaterializeFn;
  // Set shared group and write modes: overlay copy-up preserves lower-file ownership and modes.
  chownBaseDir?: (dir: string) => void;
}

export async function publishBase(args: PublishBaseArgs): Promise<PublishResult> {
  const { stateDir, scope, candidate, isAncestor } = args;
  const depthCap = args.depthCap ?? DEFAULT_DEPTH_CAP;
  const scopeHash = scopeHashOf(scope);
  const materialize: MaterializeFn =
    args.materialize ??
    ((snapshotDir, hash, generation, linkDedupBaseDir) =>
      copySnapshotToBase(stateDir, snapshotDir, hash, generation, linkDedupBaseDir));
  const chownBaseDir = args.chownBaseDir ?? shareTreeWithAllSessions;

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

    if (!current) {
      return finalize(stateDir, materialize, chownBaseDir, candidate, scopeHash, {
        outcome: "created",
        depth: 1,
        generation: 1,
      });
    }

    if (current.commit === candidate.commit) {
      return { outcome: "skipped-equal", pointer: current };
    }

    if (await isAncestor(current.commit, candidate.commit)) {
      // Keeping the generation also avoids recreating Compose containers that hold its volumes.
      if (isContentEqualPublish(current, candidate)) {
        return advanceLineageOnly(stateDir, current, candidate);
      }
      const wouldBeDepth = current.depth + 1;
      if (wouldBeDepth >= depthCap) {
        return finalize(stateDir, materialize, chownBaseDir, candidate, scopeHash, {
          outcome: "flattened",
          depth: 1,
          generation: current.generation + 1,
        }, current.baseDir);
      }
      return finalize(stateDir, materialize, chownBaseDir, candidate, scopeHash, {
        outcome: "advanced",
        depth: wouldBeDepth,
        generation: current.generation + 1,
      }, current.baseDir);
    }

    if (await isAncestor(candidate.commit, current.commit)) {
      return { outcome: "skipped-not-forward", pointer: current };
    }

    if (args.currentDefaultCommit && candidate.commit === args.currentDefaultCommit) {
      return finalize(stateDir, materialize, chownBaseDir, candidate, scopeHash, {
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
  chownBaseDir: (dir: string) => void,
  candidate: PublishCandidate,
  scopeHash: string,
  next: { outcome: PublishOutcome; depth: number; generation: number },
  linkDedupBaseDir?: string,
): Promise<PublishResult> {
  const baseDir = await materialize(candidate.snapshotDir, scopeHash, next.generation, linkDedupBaseDir);
  // Set access before publishing the pointer that lets sessions mount the generation.
  chownBaseDir(baseDir);
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

// Consult before installing: a flatten needs a clean snapshot built over an empty lowerdir.
export function shouldFlattenNext(
  stateDir: string,
  scope: OverlayScope,
  depthCap: number = DEFAULT_DEPTH_CAP,
): boolean {
  const current = readBasePointer(stateDir, scope);
  if (!current) return false;
  return current.depth + 1 >= depthCap;
}
