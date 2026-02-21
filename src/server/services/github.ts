/**
 * GitHub services — reads (status, repos, search, PR status) and mutations
 * (PR create/merge, token, logout).
 */

import type { GitManager } from "../git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import { GitManager as GitManagerClass } from "../git.js";
import { ServiceError } from "./types.js";
import type { GitHubStatus } from "./types.js";

// ---- Read operations ----

/** Get GitHub authentication status. */
export function getGitHubStatus(githubAuthManager: GitHubAuthManager): GitHubStatus {
  return githubAuthManager.getStatus();
}

/** Get user's GitHub repos (empty array if not authenticated). */
export async function getGitHubRepos(
  githubAuthManager: GitHubAuthManager,
): Promise<Array<{ fullName: string; description: string | null; private: boolean; defaultBranch: string; cloneUrl: string }>> {
  if (!githubAuthManager.authenticated) return [];
  return githubAuthManager.listUserRepos();
}

/** Search GitHub repos. */
export async function searchGitHubRepos(
  githubAuthManager: GitHubAuthManager,
  query: string,
) {
  if (!query || query.length < 2) return [];
  return githubAuthManager.searchRepos(query);
}

/** Get PR status for a session (returns null if no PR or not authenticated). */
export async function getPrStatus(
  githubAuthManager: GitHubAuthManager,
  git: GitManager,
) {
  if (!githubAuthManager.authenticated) return null;

  const remotes = await git.getRemotes();
  const origin = remotes.find((r) => r.name === "origin");
  if (!origin) return null;

  const parsed = GitManagerClass.parseGitHubRemote(origin.url);
  if (!parsed) return null;

  const head = await git.getCurrentBranch();
  const pr = await githubAuthManager.findPullRequest(parsed.owner, parsed.repo, head);
  if (!pr) return null;

  const stats = await git.diffStatVsBranch(pr.base);
  const checks = await githubAuthManager.getCheckStatus(parsed.owner, parsed.repo, head);

  return {
    url: pr.url,
    number: pr.number,
    title: pr.title,
    baseBranch: pr.base,
    headBranch: head,
    insertions: stats.insertions,
    deletions: stats.deletions,
    checks,
    autoMergeEnabled: false,
    mergeable: true,
  };
}

// ---- Mutation operations ----

/** Create a pull request. */
export async function createPullRequest(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  title: string,
  body: string,
  base: string,
  draft?: boolean,
): Promise<{ success: boolean; url?: string; number?: number; message?: string }> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");
  const trimmedTitle = title.trim();
  const trimmedBase = base.trim();
  if (!trimmedTitle) throw new ServiceError(400, "PR title is required");
  if (trimmedTitle.length > 256) throw new ServiceError(400, "PR title too long (max 256 characters)");
  if (!trimmedBase) throw new ServiceError(400, "Base branch is required");

  const remotes = await git.getRemotes();
  const origin = remotes.find((r) => r.name === "origin");
  if (!origin) throw new ServiceError(400, "No 'origin' remote configured");

  const parsed = GitManagerClass.parseGitHubRemote(origin.url);
  if (!parsed) throw new ServiceError(400, "Remote URL is not a GitHub repository");

  const head = await git.getCurrentBranch();
  const result = await githubAuthManager.createPullRequest({
    owner: parsed.owner,
    repo: parsed.repo,
    title: trimmedTitle,
    body: body.trim(),
    head,
    base: trimmedBase,
    draft,
  });
  return { success: result.success, url: result.url, number: result.number, message: result.message };
}

/** Merge a pull request. */
export async function mergePullRequest(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  method?: string,
): Promise<{ success: boolean; message: string; autoMergeEnabled?: boolean }> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");

  const remotes = await git.getRemotes();
  const origin = remotes.find((r) => r.name === "origin");
  if (!origin) return { success: false, message: "No origin remote configured" };

  const parsed = GitManagerClass.parseGitHubRemote(origin.url);
  if (!parsed) return { success: false, message: "Remote URL is not a GitHub repository" };

  const head = await git.getCurrentBranch();
  const pr = await githubAuthManager.findPullRequest(parsed.owner, parsed.repo, head);
  if (!pr) return { success: false, message: "No active PR for current branch" };

  const mergeMethod = (method || "merge") as "merge" | "squash" | "rebase";
  const result = await githubAuthManager.mergePullRequest(parsed.owner, parsed.repo, pr.number, mergeMethod);

  if (result.success) return { success: true, message: "Pull request merged" };

  // If merge failed because checks are pending, enable auto-merge
  const checks = await githubAuthManager.getCheckStatus(parsed.owner, parsed.repo, head);
  if (checks.state === "pending") {
    const graphqlMethod = mergeMethod === "merge" ? "MERGE" as const : mergeMethod === "squash" ? "SQUASH" as const : "REBASE" as const;
    const autoResult = await githubAuthManager.enableAutoMerge(parsed.owner, parsed.repo, pr.number, graphqlMethod);
    return { success: autoResult.success, message: autoResult.message, autoMergeEnabled: autoResult.success };
  }

  return { success: false, message: result.message };
}

/** Generate a PR description using the agent's generateText capability. */
export async function generatePrDescription(
  git: GitManager,
  generateText: (prompt: string, cwd?: string) => Promise<string>,
  sessionDir?: string,
): Promise<{ description: string }> {
  const log = await git.log(20);
  const diff = await git.diffSummary();

  if (log.length === 0) {
    return { description: "" };
  }

  const prompt = [
    "Write a pull request description summarizing these changes.",
    "Format as markdown with ## Summary (1-2 sentences) and ## Changes (bullet points).",
    "Keep it concise — 5-10 bullet points maximum.",
    "Return ONLY the markdown description, no extra commentary.",
    "",
    "Recent commits:",
    ...log.map((c) => `- ${c.message}`),
    "",
    "Files changed:",
    ...(diff.length > 0
      ? diff.map((f) => `- ${f.file} (+${f.insertions} -${f.deletions})`)
      : ["(no file-level diff available)"]),
  ].join("\n");

  const description = await generateText(prompt, sessionDir);
  return { description: description.trim() };
}

/** Set GitHub token. Returns status and repos. */
export async function setGitHubToken(
  githubAuthManager: GitHubAuthManager,
  token: string,
): Promise<{
  status: GitHubStatus;
  repos: Array<{ fullName: string; description: string | null; private: boolean; defaultBranch: string; cloneUrl: string }>;
}> {
  const trimmed = typeof token === "string" ? token.trim() : "";
  if (!trimmed) throw new ServiceError(400, "GitHub token cannot be empty");
  const success = await githubAuthManager.setToken(trimmed);
  if (!success) throw new ServiceError(400, "Invalid GitHub token");
  const repos = await githubAuthManager.listUserRepos();
  return { status: githubAuthManager.getStatus(), repos };
}

/** Logout from GitHub. Returns updated status. */
export function gitHubLogout(
  githubAuthManager: GitHubAuthManager,
): { status: GitHubStatus } {
  githubAuthManager.clearCredentials();
  return { status: githubAuthManager.getStatus() };
}
