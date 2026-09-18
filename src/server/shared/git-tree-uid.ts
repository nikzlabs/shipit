// Repository config can execute commands even with hooks disabled. Run git as
// the tree's trusted owner. Shared caches must have uniform ownership before use.
import fs from "node:fs";
import { identityForPath, sessionIdForPath } from "./session-identity.js";

export interface GitTreeUid {
  uid: number;
  gid: number;
}

export interface GitTreeUidDeps {
  getuid: () => number | undefined;
  statOwner: (dir: string) => { uid: number; gid: number } | null;
}

export const defaultGitTreeUidDeps: GitTreeUidDeps = {
  getuid: () => process.getuid?.(),
  statOwner: (dir: string) => {
    try {
      const st = fs.statSync(dir);
      return { uid: st.uid, gid: st.gid };
    } catch {
      return null;
    }
  },
};

// Do not cache: ownership can change between git calls.
export function resolveGitTreeUid(
  dir: string | undefined,
  deps: GitTreeUidDeps = defaultGitTreeUidDeps,
): GitTreeUid | null {
  if (!dir) return null;
  if (deps.getuid() !== 0) return null;
  // A session can chown its workspace. Use its protected identity record, and
  // never fall back to workspace ownership when that record returns null.
  if (sessionIdForPath(dir) !== null) return identityForPath(dir);
  const owner = deps.statOwner(dir);
  if (owner === null) return null;
  if (owner.uid === 0) return null;
  noteForeignTreeDrop(dir, owner);
  return { uid: owner.uid, gid: owner.gid };
}

// Bound log deduplication, not the ownership decision.
const reportedForeignTrees = new Set<string>();
const REPORTED_FOREIGN_TREE_LIMIT = 64;

function noteForeignTreeDrop(dir: string, owner: GitTreeUid): void {
  if (reportedForeignTrees.has(dir)) return;
  if (reportedForeignTrees.size >= REPORTED_FOREIGN_TREE_LIMIT) return;
  reportedForeignTrees.add(dir);
  console.warn(
    `[git-tree-uid] ${dir} belongs to no session and is owned by ${owner.uid}:${owner.gid}, `
    + `so git here runs as ${owner.uid}:${owner.gid} and not as root. If this is a tree ShipIt `
    + "owns (a bare cache, a catalog cache) that is a defect, not a configuration: read any "
    + "later `Permission denied` as \"the process dropped uid and the tree is not uniformly "
    + "owned\" (planning#425, docs/272-shared-cache-ownership).",
  );
}

// Spread inline at raw git spawn sites so git-hooks-guard-coverage.test.ts can
// verify the drop. Its scan cannot establish safety for an inherited working directory.
export function gitSpawnOverridesForTree(
  dir: string | undefined,
): { uid?: number; gid?: number } {
  const treeUid = resolveGitTreeUid(dir);
  if (treeUid === null) return {};
  return { uid: treeUid.uid, gid: treeUid.gid };
}
