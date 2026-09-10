// Shared caches belong uniformly to the orchestrator; session clones must not chown hardlinked objects.
import fs from "node:fs";
import path from "node:path";

export interface ReclaimResult {
  chowned: number;
  failed: number;
  visited: number;
  inert: boolean;
}

const INERT: ReclaimResult = { chowned: 0, failed: 0, visited: 0, inert: true };

export interface SharedTreeOwnershipDeps {
  getuid: () => number | undefined;
  getgid: () => number | undefined;
  lstat: (p: string) => { uid: number; gid: number; isDirectory: boolean } | null;
  readdir: (p: string) => string[] | null;
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

function orchestratorIdentity(deps: SharedTreeOwnershipDeps): { uid: number; gid: number } | null {
  if (deps.getuid() !== 0) return null;
  const uid = deps.getuid();
  const gid = deps.getgid();
  if (uid === undefined || gid === undefined) return null;
  return { uid, gid };
}

// Include hardlinked object files here: this is their shared owner, not a session handback.
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
  // lstat and lchown repair symlinks without traversing their targets.
  const st = deps.lstat(p);
  if (st === null) return;
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

// The hot-path check sees only the root; the boot walk repairs deeper ownership drift.
export function ensureSharedTreeOwnedByShipIt(
  dir: string,
  context: string,
  deps: SharedTreeOwnershipDeps = defaultSharedTreeOwnershipDeps,
): ReclaimResult {
  const owner = orchestratorIdentity(deps);
  if (owner === null) return INERT;
  const st = deps.lstat(dir);
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
