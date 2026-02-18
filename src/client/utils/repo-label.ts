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
