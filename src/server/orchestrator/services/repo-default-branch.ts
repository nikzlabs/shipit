import type { RepoStore } from "../repo-store.js";
import { canonicalRepoKey } from "../git-utils.js";
import { getErrorMessage } from "../validation.js";

export const FALLBACK_DEFAULT_BRANCH = "main";

interface DefaultBranchReader {
  getDefaultBranch(remote?: string): Promise<string>;
}

export interface RepoDefaultBranchDeps {
  repoStore: RepoStore;
  createRepoGit: (dir: string) => DefaultBranchReader;
  getBareCacheDir: (repoUrl: string) => string;
  sseBroadcast?: (event: string, data: unknown) => void;
  cacheExists?: (dir: string) => Promise<boolean>;
}

async function defaultCacheExists(dir: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  // eslint-disable-next-line no-restricted-syntax -- stat existence-check idiom
  return stat(dir).then(() => true, () => false);
}

export async function refreshRepoDefaultBranch(
  deps: RepoDefaultBranchDeps,
  repoUrl: string,
): Promise<string | undefined> {
  const { repoStore, createRepoGit, getBareCacheDir, sseBroadcast } = deps;
  const exists = deps.cacheExists ?? defaultCacheExists;

  try {
    const cacheDir = getBareCacheDir(repoUrl);
    if (!(await exists(cacheDir))) return undefined;

    const branch = (await createRepoGit(cacheDir).getDefaultBranch()).trim();
    if (!branch) return undefined;

    if (repoStore.get(repoUrl)?.defaultBranch === branch) return branch;

    if (repoStore.setDefaultBranch(repoUrl, branch) && sseBroadcast) {
      sseBroadcast("repo_list", { repos: repoStore.list() });
    }
    return branch;
  } catch (err) {
    console.error(
      `[repo-default-branch] failed to resolve for ${repoUrl}:`,
      getErrorMessage(err),
    );
    return undefined;
  }
}

export async function refreshAllRepoDefaultBranches(
  deps: RepoDefaultBranchDeps,
): Promise<void> {
  const { repoStore, sseBroadcast } = deps;
  let changed = false;
  for (const repo of repoStore.list()) {
    const before = repo.defaultBranch;
    const { sseBroadcast: _omit, ...quiet } = deps;
    const after = await refreshRepoDefaultBranch(quiet, repo.url);
    if (after && after !== before) changed = true;
  }
  if (changed && sseBroadcast) {
    sseBroadcast("repo_list", { repos: repoStore.list() });
  }
}

export function repoDefaultBranch(
  repoStore: RepoStore,
  repoUrl: string | undefined,
): string {
  if (!repoUrl?.trim()) return FALLBACK_DEFAULT_BRANCH;
  const exact = repoStore.get(repoUrl)?.defaultBranch;
  if (exact) return exact;
  const key = canonicalRepoKey(repoUrl);
  const match = repoStore.list().find((r) => canonicalRepoKey(r.url) === key);
  return match?.defaultBranch ?? FALLBACK_DEFAULT_BRANCH;
}
