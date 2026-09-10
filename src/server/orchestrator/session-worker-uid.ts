import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveShipitConfig, DEFAULT_DEP_DIRS } from "../shared/shipit-config.js";
import { identityForPath, sessionDirFor, type SessionIdentity } from "../shared/session-identity.js";
import { resolveGitTreeUid, type GitTreeUidDeps } from "../shared/git-tree-uid.js";
import { EGRESS_RESOLVER_UID } from "./egress-dns.js";
import { EGRESS_PROXY_UID } from "./egress-proxy-install.js";

// Firewall owner-match exempts these UIDs; workloads must never inherit those exemptions.
export const RESERVED_EGRESS_UIDS: readonly number[] = [EGRESS_RESOLVER_UID, EGRESS_PROXY_UID];

export class ReservedWorkerUidError extends Error {
  constructor(readonly uid: number) {
    super(
      `[session-worker-uid] Refusing to start: SHIPIT_SESSION_WORKER_UID=${uid} is a reserved ` +
        `egress-sidecar UID (${EGRESS_RESOLVER_UID}=DNS resolver, ${EGRESS_PROXY_UID}=SNI proxy). ` +
        `The netns firewall exempts those UIDs from the controls that name them, so every agent, ` +
        `and plugin workload would silently escape ${uid === EGRESS_RESOLVER_UID
          ? "the DNS lock"
          : "the :443 SNI redirect"} in contained sessions. Set SHIPIT_SESSION_WORKER_UID to a ` +
        `non-root UID outside ${RESERVED_EGRESS_UIDS.join("/")} (the deployment files use 1000). ` +
        `Ownership follows on its own: the entrypoint's handoff sentinel is UID-stamped ` +
        `(docker/session-worker/entrypoint.sh:75), so each session re-chowns once the next time ` +
        `its container is CREATED. Containers already running under ${uid} are adopted as-is on ` +
        `restart and keep that UID — archive or reset those sessions to retire them.`,
    );
    this.name = "ReservedWorkerUidError";
  }
}

// A reserved UID must throw: the entrypoint would still use the raw value if we returned null.
export function sessionWorkerUid(): number | null {
  const raw = process.env.SHIPIT_SESSION_WORKER_UID;
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) return null;
  if (RESERVED_EGRESS_UIDS.includes(n)) throw new ReservedWorkerUidError(n);
  return n;
}

export function assertWorkerUidNotReserved(): void {
  sessionWorkerUid();
}

// Sessions share a primary GID for dependency caches; their 0700 roots isolate private files.
// spawn({uid, gid}) does not initialize supplementary groups.
export function sessionWorkerGid(): number | null {
  return sessionWorkerUid();
}

export function identityForSession(sessionId: string): SessionIdentity | null {
  const dir = sessionDirFor(sessionId);
  return dir === null ? identityForTarget("") : identityForTarget(dir);
}

export function identityForTarget(targetPath: string): SessionIdentity | null {
  const owner = identityForPath(targetPath);
  if (owner !== null) return owner;
  const uid = sessionWorkerUid();
  return uid === null ? null : { uid, gid: uid };
}

// The 0700 root blocks other sessions regardless of the modes of files inside it.
export function sealSessionDir(sessionDir: string, identity: SessionIdentity): boolean {
  try {
    fs.chownSync(sessionDir, identity.uid, identity.gid);
    fs.chmodSync(sessionDir, 0o700);
    return true;
  } catch (err) {
    console.warn(`[session-worker-uid] could not seal session dir ${sessionDir}:`, err);
    return false;
  }
}

export function sealDirMode(dir: string): void {
  if (sessionWorkerGid() === null) return;
  try {
    fs.chmodSync(dir, 0o700);
  } catch (err) {
    console.warn(`[session-worker-uid] could not seal mode on ${dir}:`, err);
  }
}

// Overlay copy-up preserves lower ownership and mode, so shared bases need group write.
export function shareTreeWithAllSessions(targetPath: string): void {
  const gid = sessionWorkerGid();
  if (gid === null) return;
  shareRecursive(targetPath, gid);
}

// Repair existing caches once per GID. A changed repair needs a marker version bump.
// Use beside for overlay bases so the marker does not appear in the user's dependencies.
export function shareTreeOnce(targetPath: string, opts: { beside?: boolean } = {}): void {
  const gid = sessionWorkerGid();
  if (gid === null) return;
  const marker = opts.beside
    ? `${targetPath}${SHARED_GID_MARKER_PREFIX}${gid}`
    : path.join(targetPath, `${SHARED_GID_MARKER_PREFIX}${gid}`);
  try {
    if (fs.existsSync(marker)) return;
  } catch {
    return;
  }
  shareRecursive(targetPath, gid);
  try {
    fs.writeFileSync(marker, "");
    fs.chmodSync(marker, 0o664);
    fs.lchownSync(marker, fs.lstatSync(marker).uid, gid);
  } catch (err) {
    console.warn(`[session-worker-uid] shared-gid marker write failed for ${targetPath}:`, err);
  }
}

export const SHARED_GID_MARKER_PREFIX = ".shipit-shared-gid-";

// Contents need a separate recursive pass; the entrypoint prunes shared mounts.
export function shareWithAllSessions(targetPath: string): void {
  const gid = sessionWorkerGid();
  if (gid === null) return;
  shareOne(targetPath, gid);
}

function shareOne(p: string, gid: number): fs.Stats | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(p);
  } catch {
    return null;
  }
  try {
    fs.lchownSync(p, stat.uid, gid);
  } catch (err) {
    console.warn(`[session-worker-uid] group share failed for ${p}:`, err);
  }
  addGroupWrite(p, stat);
  return stat;
}

function addGroupWrite(p: string, stat: fs.Stats): void {
  // chmod follows symlinks and could change a file outside this tree.
  if (stat.isSymbolicLink()) return;
  const mode = stat.mode & 0o7777;
  const next = stat.isDirectory() ? mode | 0o2070 : mode | 0o060;
  if (next === mode) return;
  try {
    fs.chmodSync(p, next);
  } catch (err) {
    console.warn(`[session-worker-uid] group-write chmod failed for ${p}:`, err);
  }
}

const DEFAULT_ACL_BATCH = 256;

export type DefaultAclRunner = (dirs: readonly string[]) => void;

function spawnSetfacl(dirs: readonly string[]): void {
  execFileSync("setfacl", ["-d", "-m", "g::rwx", "--", ...dirs], { stdio: "ignore" });
}

// Setgid preserves the group, not group write. Default ACLs also cover future service files.
export function applyDefaultGroupAcl(dirs: readonly string[], run: DefaultAclRunner = spawnSetfacl): void {
  let refused = 0;
  let firstError = "";
  for (let i = 0; i < dirs.length; i += DEFAULT_ACL_BATCH) {
    const batch = dirs.slice(i, i + DEFAULT_ACL_BATCH);
    try {
      run(batch);
    } catch (err) {
      refused += batch.length;
      if (!firstError) firstError = err instanceof Error ? err.message : String(err);
      // Missing setfacl affects every batch; a vanished directory affects only its batch.
      if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") break;
    }
  }
  if (refused > 0) {
    console.warn(
      `[session-worker-uid] default-ACL pass failed for ${refused} of ${dirs.length} directories — `
      + "what a foreign-uid Compose service creates in those will not be group-writable "
      + `(docs/271 §3): ${firstError}`,
    );
  }
}

function shareRecursive(p: string, gid: number): void {
  const stat = shareOne(p, gid);
  if (!stat?.isDirectory()) return;
  let entries: string[];
  try {
    entries = fs.readdirSync(p);
  } catch {
    return;
  }
  for (const entry of entries) shareRecursive(path.join(p, entry), gid);
}

// Scan disk to include orphaned directories whose session rows are gone.
export function sealLegacySessionDirs(sessionsRoot: string): number {
  const gid = sessionWorkerGid();
  if (gid === null) return 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  let sealed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(sessionsRoot, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (stat.uid !== 0) continue;
    if (sealSessionDir(dir, { uid: gid, gid })) sealed += 1;
  }
  if (sealed > 0) {
    console.log(`[session-worker-uid] docs/270: sealed ${sealed} pre-existing session director${sealed === 1 ? "y" : "ies"} at the shared uid ${gid}`);
  }
  return sealed;
}

export function chownToSessionWorker(targetPath: string): void {
  const owner = identityForTarget(targetPath);
  if (owner === null) return;
  try {
    fs.lchownSync(targetPath, owner.uid, owner.gid);
  } catch (err) {
    console.warn(`[session-worker-uid] chown failed for ${targetPath}:`, err);
  }
}

// Do not use on git checkouts: object files can be hardlinked into a shared cache.
export function chownTreeToSessionWorker(targetPath: string): void {
  const owner = identityForTarget(targetPath);
  if (owner === null) return;
  chownRecursive(targetPath, owner);
}

export function chownWorkspaceGitToSessionWorker(workspaceDir: string, deps?: GitTreeUidDeps): void {
  const owner = resolveGitDirOwner(workspaceDir, deps);
  if (owner === null) return;
  const gitDir = path.join(workspaceDir, ".git");
  chownGitMetadataRecursive(gitDir, owner, path.join(gitDir, "objects"), path.join(gitDir, "lfs", "objects"));
}

// Prefer the identity orchestrator git actually uses; a recorded identity can disagree.
export function resolveGitDirOwner(
  workspaceDir: string,
  deps?: GitTreeUidDeps,
): SessionIdentity | null {
  const treeUid = deps ? resolveGitTreeUid(workspaceDir, deps) : resolveGitTreeUid(workspaceDir);
  if (treeUid !== null) return treeUid;
  return identityForTarget(workspaceDir);
}

export function chownWorktreeToSessionWorker(workspaceDir: string, excludeRelDirs: string[] = []): void {
  const owner = identityForTarget(workspaceDir);
  if (owner === null) return;
  const exclude = new Set<string>([".git", ...excludeRelDirs.map((d) => path.normalize(d))]);
  const dirs: string[] = [];
  chownWorktreeRecursive(workspaceDir, owner, workspaceDir, exclude, dirs);
  applyDefaultGroupAcl(dirs);
}

// Each half resolves its own identity: git's drop and the container UID can differ.
export function handWorkspaceBackToWorker(workspaceDir: string): void {
  chownWorkspaceGitToSessionWorker(workspaceDir);
  let depDirs: string[];
  try {
    depDirs = resolveShipitConfig(workspaceDir).agent.depDirs;
  } catch {
    depDirs = [...DEFAULT_DEP_DIRS];
  }
  chownWorktreeToSessionWorker(workspaceDir, depDirs);
}

// Include committed dependency directories: they become the plugin overlay's lower layer.
export function handPluginCheckoutToWorker(checkoutDir: string): void {
  chownWorkspaceGitToSessionWorker(checkoutDir);
  chownWorktreeToSessionWorker(checkoutDir);
}

// Use only a session's writable dep directory or overlay upperdir, never the shared lowerdir.
// Scan direct children and recurse only into trees whose ownership differs.
export function reconcileDepDirCacheOwnership(depDirPath: string): void {
  const owner = identityForTarget(depDirPath);
  if (owner === null) return;
  const rootStat = lstatOrNull(depDirPath);
  if (rootStat === null) return;
  // readdir would follow this link outside the session.
  if (rootStat.isSymbolicLink()) return;
  addGroupWrite(depDirPath, rootStat);
  let entries: string[];
  try {
    entries = fs.readdirSync(depDirPath);
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = path.join(depDirPath, entry);
    const stat = lstatOrNull(child);
    if (stat === null) continue;
    if (stat.uid !== owner.uid || stat.gid !== owner.gid) {
      chownRecursive(child, owner);
      groupWriteRecursive(child);
    }
  }
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

// Keep mode changes out of chownRecursive: its credential callers require private modes.
function groupWriteRecursive(p: string): void {
  const stat = lstatOrNull(p);
  if (stat === null) return;
  addGroupWrite(p, stat);
  if (!stat.isDirectory()) return;
  let entries: string[];
  try {
    entries = fs.readdirSync(p);
  } catch {
    return;
  }
  for (const entry of entries) groupWriteRecursive(path.join(p, entry));
}

function chownWorktreeRecursive(
  p: string,
  owner: SessionIdentity,
  root: string,
  exclude: Set<string>,
  dirs: string[],
): void {
  const rel = path.relative(root, p);
  if (rel !== "" && exclude.has(rel)) return;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(p);
  } catch {
    return;
  }
  lchownLogged(p, owner);
  addGroupWrite(p, stat);
  if (stat.isDirectory()) {
    dirs.push(p);
    let entries: string[];
    try {
      entries = fs.readdirSync(p);
    } catch {
      return;
    }
    for (const entry of entries) {
      chownWorktreeRecursive(path.join(p, entry), owner, root, exclude, dirs);
    }
  }
}

function lchownLogged(p: string, owner: SessionIdentity): void {
  try {
    fs.lchownSync(p, owner.uid, owner.gid);
  } catch (err) {
    console.warn(`[session-worker-uid] chown failed for ${p}:`, err);
  }
}

// Object data can be hardlinked to shared caches: chowning it changes the shared inode.
// Own directories so git can add and prune objects; existing data stays immutable and readable.
function chownGitMetadataRecursive(p: string, owner: SessionIdentity, objectsDir: string, lfsObjectsDir: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(p);
  } catch {
    return;
  }

  if (p === lfsObjectsDir && stat.isDirectory()) {
    chownDirsOnlyRecursive(p, owner);
    return;
  }

  if (p === objectsDir && stat.isDirectory()) {
    lchownLogged(p, owner);
    let entries: string[];
    try {
      entries = fs.readdirSync(p);
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(p, entry);
      try {
        if (fs.lstatSync(child).isDirectory()) lchownLogged(child, owner);
      } catch {
        // Entry vanished during the walk.
      }
    }
    return;
  }

  lchownLogged(p, owner);
  if (stat.isDirectory()) {
    let entries: string[];
    try {
      entries = fs.readdirSync(p);
    } catch {
      return;
    }
    for (const entry of entries) {
      chownGitMetadataRecursive(path.join(p, entry), owner, objectsDir, lfsObjectsDir);
    }
  }
}

// LFS has two directory levels, so its directory-only walk must recurse.
function chownDirsOnlyRecursive(p: string, owner: SessionIdentity): void {
  lchownLogged(p, owner);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) chownDirsOnlyRecursive(path.join(p, entry.name), owner);
  }
}

function chownRecursive(p: string, owner: SessionIdentity): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(p);
  } catch {
    return;
  }
  try {
    fs.lchownSync(p, owner.uid, owner.gid);
  } catch (err) {
    console.warn(`[session-worker-uid] chown failed for ${p}:`, err);
  }
  // lstat prevents traversal through symlinks.
  if (stat.isDirectory()) {
    let entries: string[];
    try {
      entries = fs.readdirSync(p);
    } catch {
      return;
    }
    for (const entry of entries) {
      chownRecursive(path.join(p, entry), owner);
    }
  }
}
