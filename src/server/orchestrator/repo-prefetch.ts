import fs from "node:fs";
import fsp from "node:fs/promises";
import type { RepoStore } from "./repo-store.js";
import { ensureBareCache, type RepoGit } from "./repo-git.js";
import type { GitHubAuthManager } from "./github-auth.js";
import { getErrorMessage } from "./validation.js";
import { fetchLfsIntoCache } from "./git-lfs-store.js";
import { gitRemoteCredentialResolver } from "./services/github.js";

export const PREFETCH_INTERVAL_MS = 3 * 60_000;

// Allow one missed sweep before claims fall back to synchronous fetching.
export const CLAIM_SKIP_WINDOW_MS = 2 * PREFETCH_INTERVAL_MS;

export interface RepoPrefetcherDeps {
  repoStore: RepoStore;
  getBareCacheDir: (repoUrl: string) => string;
  createRepoGit: (dir: string) => RepoGit;
  githubAuthManager: GitHubAuthManager;
}

export interface RepoPrefetcher {
  start(): void;
  stop(): void;
  prefetchRepo(repoUrl: string): void;
  coveredRecently(repoUrl: string): boolean;
}

const OWNERSHIP_SHAPED = /permission denied|insufficient permission|dubious ownership|operation not permitted/i;

// Capture ownership at failure; session containers cannot inspect the orchestrator volume.
function describeOwnershipFailure(cacheDir: string, err: unknown): void {
  if (!OWNERSHIP_SHAPED.test(getErrorMessage(err))) return;
  let owner = "unreadable";
  try {
    const st = fs.statSync(cacheDir);
    owner = `${st.uid}:${st.gid}`;
  } catch {
    // Keep the unreadable diagnostic.
  }
  console.error(
    `[prefetch] ${cacheDir} could not be updated for an OWNERSHIP reason, so this cache is now `
    + `lagging silently: refs stop advancing and anything served from it is stale. Process uid `
    + `${process.getuid?.() ?? "?"}:${process.getgid?.() ?? "?"}, cache owner ${owner}. A root `
    + "process getting a permission error means it DROPPED uid (docs/266) and the tree is not "
    + "uniformly owned — not that the privilege is missing. The repair runs on the next fetch "
    + "(shared-tree-ownership.ts); if this line repeats, that repair is failing too.",
  );
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// Refresh only bare caches; live session branches must not move under an agent.
export function createRepoPrefetcher(deps: RepoPrefetcherDeps): RepoPrefetcher {
  const { repoStore, getBareCacheDir, createRepoGit, githubAuthManager } = deps;

  const inFlight = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const fetchOne = async (repoUrl: string, { recreate }: { recreate: boolean }): Promise<void> => {
    if (inFlight.has(repoUrl)) return;
    const repo = repoStore.get(repoUrl);
    if (repo?.status !== "ready") return;
    // A cache the janitor reclaimed stays gone until something uses the repo;
    // re-cloning it here made the two fight every 3 minutes.
    if (!recreate && !(await pathExists(getBareCacheDir(repoUrl)))) return;
    inFlight.add(repoUrl);
    try {
      // Repairs a corrupt cache, and recreates a missing one for an explicit prefetch.
      const { git: cacheGit } = await ensureBareCache(
        getBareCacheDir(repoUrl),
        repoUrl,
        createRepoGit,
      );
      // Credentials are supplied per invocation, never embedded in origin.
      if (githubAuthManager.authenticated) {
        await cacheGit.setRemoteUrl(repoUrl);
      }
      await cacheGit.fetchCache();
      // Keep large LFS transfers out of fetchCache, which claims await.
      await fetchLfsIntoCache(getBareCacheDir(repoUrl), {
        resolveCredential: gitRemoteCredentialResolver(githubAuthManager),
      });
    } catch (err) {
      console.warn(`[prefetch] Bare-cache fetch failed for ${repoUrl} (non-fatal):`, getErrorMessage(err));
      describeOwnershipFailure(getBareCacheDir(repoUrl), err);
    } finally {
      inFlight.delete(repoUrl);
    }
  };

  const sweep = (): void => {
    for (const repo of repoStore.list()) {
      if (repo.status === "ready") void fetchOne(repo.url, { recreate: false });
    }
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(sweep, PREFETCH_INTERVAL_MS);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    prefetchRepo(repoUrl: string) {
      void fetchOne(repoUrl, { recreate: true });
    },
    coveredRecently(repoUrl: string): boolean {
      const repo = repoStore.get(repoUrl);
      if (repo?.status !== "ready") return false;
      try {
        const ageMs = createRepoGit(getBareCacheDir(repoUrl)).lastFetchAgeMs();
        return ageMs !== null && ageMs <= CLAIM_SKIP_WINDOW_MS;
      } catch {
        // A missing cache throws in the constructor; let the claim repair it.
        return false;
      }
    },
  };
}
