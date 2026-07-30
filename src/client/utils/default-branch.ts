/**
 * "What is this session's base branch?" — one answer for the whole client.
 *
 * Several surfaces need a base branch *before* a PR exists, at which point
 * there's no `pr.baseBranch` to read: the rebase banner ("Branch is behind
 * <base>"), the overflow menu's "Sync with <base>", and the "Changes vs <base>"
 * diff. Each of those used to hard-code `"main"`, which is simply wrong on a
 * `master` (or `trunk`, or `develop`) repo — the banner named a branch that
 * doesn't exist and the diff request 400'd on an unresolvable base.
 *
 * The real value now rides the `repo_list` SSE as `RepoInfo.defaultBranch`
 * (resolved server-side from the bare cache's HEAD — see
 * `services/repo-default-branch.ts`). This module maps a session to its repo
 * and reads it, falling back to `"main"` when the repo isn't known yet or the
 * session has no remote at all. That fallback is the pre-existing behavior, so
 * the worst case is exactly what shipped before, never worse.
 */

import type { RepoInfo } from "../../server/shared/types.js";
import { useRepoStore } from "../stores/repo-store.js";
import { useSessionStore } from "../stores/session-store.js";

/** The guess used until the repo's real default branch is known. */
export const FALLBACK_DEFAULT_BRANCH = "main";

/** Tolerant repo-URL match — mirrors the server's `canonicalRepoKey` fallback. */
export function normalizeRepoUrl(u: string): string {
  return u.trim().toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
}

/** Find a tracked repo by URL, tolerant of `.git` / trailing-slash variance. */
export function findRepoByUrl(
  repos: RepoInfo[],
  url: string | undefined,
): RepoInfo | undefined {
  if (!url?.trim()) return undefined;
  const key = normalizeRepoUrl(url);
  return repos.find((r) => normalizeRepoUrl(r.url) === key);
}

/** The base branch for a remote URL — its resolved default, else `"main"`. */
export function resolveDefaultBranch(
  repos: RepoInfo[],
  remoteUrl: string | undefined,
): string {
  return findRepoByUrl(repos, remoteUrl)?.defaultBranch ?? FALLBACK_DEFAULT_BRANCH;
}

/**
 * The default branch of the repo backing `sessionId`. Re-renders when the repo
 * list updates (the value arrives asynchronously over SSE shortly after boot),
 * so a component reading this settles onto the real branch on its own.
 *
 * Pass `undefined` for "no session" — you get the fallback rather than a crash,
 * which keeps this usable from components that render before hydration.
 */
export function useSessionDefaultBranch(sessionId: string | undefined): string {
  const remoteUrl = useSessionStore((s) =>
    sessionId ? s.sessions.find((sess) => sess.id === sessionId)?.remoteUrl : undefined,
  );
  const repos = useRepoStore((s) => s.repos);
  return resolveDefaultBranch(repos, remoteUrl);
}
