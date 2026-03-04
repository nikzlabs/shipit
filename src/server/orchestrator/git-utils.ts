import crypto from "node:crypto";

/** Generate a short random branch suffix for the "shipit/" namespace. */
export function generateBranchSlug(): string {
  // 4.5 bytes → 6 base64url chars (no padding). Used as a uniqueness suffix
  // so branch names read as shipit/<descriptive-name>-<random>.
  return crypto.randomBytes(6).toString("base64url").toLowerCase().slice(0, 6);
}

/** Generate a branch name in the "shipit/" namespace with only the random slug. */
export function generateBranchPrefix(): string {
  return "shipit/" + generateBranchSlug();
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
