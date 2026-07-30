/**
 * Repo default-branch resolution.
 *
 * ShipIt used to assume every repo's default branch was `main` — hard-coded in
 * the rebase banner, the "Sync with <base>" action, the "Changes vs <base>"
 * diff, and the `diff-vs-branch` route's fallback. On a `master` (or `trunk`,
 * or `develop`) repo every one of those was wrong: the banner named a branch
 * that doesn't exist, and the diff request 400'd on an unresolvable base.
 *
 * The real value is already sitting in the bare cache — `git clone --bare` sets
 * HEAD to the remote's default branch, so `RepoGit.getDefaultBranch()` reads it
 * locally with no network call and no credential prompt. This module resolves
 * it once per repo and persists it on `RepoInfo.defaultBranch`, which rides the
 * existing `repo_list` SSE out to the browser.
 *
 * Deliberately best-effort and off the request path: a repo whose cache isn't
 * on disk yet (or whose HEAD can't be read) simply keeps `defaultBranch`
 * undefined, and every consumer falls back to `"main"` exactly as before.
 */

import type { RepoStore } from "../repo-store.js";
import { canonicalRepoKey } from "../git-utils.js";
import { getErrorMessage } from "../validation.js";

/** The pre-resolution guess. Every consumer falls back to this. */
export const FALLBACK_DEFAULT_BRANCH = "main";

/** Minimal shape of `RepoGit` this module needs — keeps tests free of git. */
interface DefaultBranchReader {
  getDefaultBranch(remote?: string): Promise<string>;
}

export interface RepoDefaultBranchDeps {
  repoStore: RepoStore;
  createRepoGit: (dir: string) => DefaultBranchReader;
  getBareCacheDir: (repoUrl: string) => string;
  /** Optional — when provided, a changed value re-broadcasts the repo list. */
  sseBroadcast?: (event: string, data: unknown) => void;
  /** Injectable for tests; defaults to a real `fs.stat` existence check. */
  cacheExists?: (dir: string) => Promise<boolean>;
}

async function defaultCacheExists(dir: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  // eslint-disable-next-line no-restricted-syntax -- stat existence-check idiom
  return stat(dir).then(() => true, () => false);
}

/**
 * Resolve and persist one repo's default branch. Returns the resolved branch,
 * or `undefined` when it couldn't be determined (cache missing, git error) —
 * in which case the stored value is left untouched rather than overwritten with
 * a guess.
 */
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

    // No-op when unchanged: avoids a pointless write + SSE fan-out on every
    // boot for the (overwhelmingly common) steady state.
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

/**
 * Resolve every tracked repo's default branch. Runs once at boot so repos added
 * before this field existed (and repos whose remote renamed its default branch)
 * pick the real value up without the user re-adding them. Broadcasts at most
 * once, after the sweep, rather than per repo.
 */
export async function refreshAllRepoDefaultBranches(
  deps: RepoDefaultBranchDeps,
): Promise<void> {
  const { repoStore, sseBroadcast } = deps;
  let changed = false;
  for (const repo of repoStore.list()) {
    const before = repo.defaultBranch;
    // Suppress the per-repo broadcast; we send one at the end instead.
    const { sseBroadcast: _omit, ...quiet } = deps;
    const after = await refreshRepoDefaultBranch(quiet, repo.url);
    if (after && after !== before) changed = true;
  }
  if (changed && sseBroadcast) {
    sseBroadcast("repo_list", { repos: repoStore.list() });
  }
}

/**
 * The base branch to use for a repo — its resolved default, else `"main"`.
 * The single server-side answer to "what is this repo's base branch?", so
 * routes don't each re-invent the fallback.
 *
 * Matched by `canonicalRepoKey` rather than raw-URL equality (same reasoning as
 * `RepoStore.isTrusted`): a session's `remoteUrl` and the tracked repo's `url`
 * can differ in `.git` suffix / scheme while naming the same repo.
 */
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
