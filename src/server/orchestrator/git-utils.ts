import crypto from "node:crypto";
import type { GitManager } from "../shared/git.js";

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

/** Hash a repo URL to a short 16-char hex string for use as a directory name. */
export function repoUrlToHash(repoUrl: string): string {
  return crypto.createHash("sha256").update(repoUrl).digest("hex").slice(0, 16);
}

/**
 * Push the current branch to origin. Returns the branch name on success, or null
 * if there is no origin remote or no current branch.
 */
export async function pushToOrigin(git: GitManager): Promise<string | null> {
  const remotes = await git.getRemotes();
  const origin = remotes.find((r) => r.name === "origin");
  if (!origin) return null;
  const branch = await git.getCurrentBranch();
  if (!branch) return null;
  await git.push("origin", branch);
  return branch;
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
