/**
 * Extract a display label from a remote URL.
 *   "https://github.com/owner/repo.git" → "owner/repo"
 *   "git@github.com:owner/repo.git"     → "owner/repo"
 *   "https://example.com/path/repo"     → "example.com/path/repo"
 */
export function parseRepoLabel(remoteUrl: string): string {
  // GitHub HTTPS: https://github.com/owner/repo.git
  const httpsMatch = remoteUrl.match(/github\.com\/([^/]+\/[^/.]+)/);
  if (httpsMatch) return httpsMatch[1];
  // GitHub SSH: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/github\.com:([^/]+\/[^/.]+)/);
  if (sshMatch) return sshMatch[1];
  // Generic: strip protocol and .git suffix
  try {
    const u = new URL(remoteUrl);
    return (u.hostname + u.pathname).replace(/\.git$/, "");
  } catch {
    return remoteUrl.replace(/\.git$/, "");
  }
}

/** URL prefix for repo-scoped new-session routes. */
export const REPO_ROUTE_PREFIX = "/repo/";

const REPO_NEW_SUFFIX = "/new";

/** Build the "new session" URL path for a repo: `/repo/{label}/new`. */
export function repoLabelToNewPath(repoUrl: string): string {
  return `${REPO_ROUTE_PREFIX}${parseRepoLabel(repoUrl)}${REPO_NEW_SUFFIX}`;
}

/** Parse a new-session route from a pathname. Returns the repo slug or undefined. */
export function parseNewSessionSlug(pathname: string): string | undefined {
  if (pathname.startsWith(REPO_ROUTE_PREFIX) && pathname.endsWith(REPO_NEW_SUFFIX)) {
    const slug = pathname.slice(REPO_ROUTE_PREFIX.length, -REPO_NEW_SUFFIX.length);
    return slug.length > 0 ? decodeURIComponent(slug) : undefined;
  }
  return undefined;
}
