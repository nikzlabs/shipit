

export function parseRepoLabel(remoteUrl: string): string {

  const httpsMatch = /github\.com\/([^/]+\/[^/.]+)/.exec(remoteUrl);
  if (httpsMatch) return httpsMatch[1];

  const sshMatch = /github\.com:([^/]+\/[^/.]+)/.exec(remoteUrl);
  if (sshMatch) return sshMatch[1];
  // Generic: strip protocol and .git suffix
  try {
    const u = new URL(remoteUrl);
    return (u.hostname + u.pathname).replace(/\.git$/, "");
  } catch {
    return remoteUrl.replace(/\.git$/, "");
  }
}

export function parseRepoName(remoteUrl: string): string {
  const label = parseRepoLabel(remoteUrl);
  const slashIdx = label.lastIndexOf("/");
  return slashIdx >= 0 ? label.slice(slashIdx + 1) : label;
}

export const REPO_ROUTE_PREFIX = "/repo/";

const REPO_NEW_SUFFIX = "/new";

export function repoLabelToNewPath(repoUrl: string): string {
  return `${REPO_ROUTE_PREFIX}${parseRepoLabel(repoUrl)}${REPO_NEW_SUFFIX}`;
}

export function parseNewSessionSlug(pathname: string): string | undefined {
  if (pathname.startsWith(REPO_ROUTE_PREFIX) && pathname.endsWith(REPO_NEW_SUFFIX)) {
    const slug = pathname.slice(REPO_ROUTE_PREFIX.length, -REPO_NEW_SUFFIX.length);
    return slug.length > 0 ? decodeURIComponent(slug) : undefined;
  }
  return undefined;
}

export function shouldAdoptClaimedSession(input: {
  claimed: boolean;
  aborted: boolean;
  currentPathname: string;
  repoUrl: string;
}): boolean {
  if (!input.claimed || input.aborted) return false;
  return parseNewSessionSlug(input.currentPathname) === parseRepoLabel(input.repoUrl);
}
