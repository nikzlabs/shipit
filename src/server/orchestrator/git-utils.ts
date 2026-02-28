import crypto from "node:crypto";

/** Generate a short random branch prefix in the "shipit/" namespace. */
export function generateBranchPrefix(): string {
  // 3 bytes → exactly 4 base64url chars (no padding). The 'shipit/' namespace
  // groups all agent branches together and avoids git's '-' prefix rejection.
  return "shipit/" + crypto.randomBytes(3).toString("base64url").toLowerCase();
}

/** Parse owner/repo from a GitHub remote URL. */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  // Handle HTTPS: https://github.com/owner/repo.git
  const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  // Handle SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/github\.com:([^/]+)\/([^/.]+)/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
  return null;
}
