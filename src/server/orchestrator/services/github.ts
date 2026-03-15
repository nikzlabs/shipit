/**
 * GitHub services — reads (status, repos, search, PR status) and mutations
 * (PR create/merge, token, logout, quick PR creation).
 */

import type { GitManager } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { ChatHistoryManager } from "../chat-history.js";
import type { PrAutoMergeError } from "../../shared/types/github-types.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import { parseGitHubRemote } from "../git-utils.js";
import { ServiceError } from "./types.js";
import { getErrorMessage } from "../validation.js";
import type { GitHubStatus } from "./types.js";

/**
 * Resolve owner/repo from a known remote URL or by reading git remotes.
 * Prefers the explicit remoteUrl (from session metadata) over reading from git,
 * since local clones from the bare cache may have a filesystem path as origin.
 *
 * Returns `{ owner, repo }` on success, or `{ error }` explaining the failure.
 */
async function resolveGitHubRemote(
  git: GitManager,
  remoteUrl?: string,
): Promise<{ owner: string; repo: string } | { error: string }> {
  if (remoteUrl) {
    const parsed = parseGitHubRemote(remoteUrl);
    if (parsed) {
      // Fix the git remote if it doesn't match (e.g., points to bare cache path).
      // This makes subsequent git push/pull operations work correctly.
      const remotes = await git.getRemotes();
      const origin = remotes.find((r) => r.name === "origin");
      if (!origin || origin.url !== remoteUrl) {
        await git.addRemote("origin", remoteUrl);
      }
      return parsed;
    }
  }
  const remotes = await git.getRemotes();
  const origin = remotes.find((r) => r.name === "origin");
  if (!origin) return { error: "No 'origin' remote configured" };
  const parsed = parseGitHubRemote(origin.url);
  if (!parsed) return { error: "Remote URL is not a GitHub repository" };
  return parsed;
}

// Re-export CI-fix logic for backwards compatibility
export {
  fetchCIFailureLogs,
  stripCILogBloat,
  extractErrorLines,
  buildCIFixPrompt,
  triggerCIFix,
} from "./github-ci-fix.js";

// ---- Read operations ----

/** Get GitHub authentication status. */
export function getGitHubStatus(githubAuthManager: GitHubAuthManager): GitHubStatus {
  return githubAuthManager.getStatus();
}

/** Get user's GitHub repos (empty array if not authenticated). */
export async function getGitHubRepos(
  githubAuthManager: GitHubAuthManager,
): Promise<{ fullName: string; description: string | null; private: boolean; defaultBranch: string; cloneUrl: string }[]> {
  if (!githubAuthManager.authenticated) return [];
  return githubAuthManager.listUserRepos();
}

/** Search GitHub repos. Returns user's repos when query is empty. */
export async function searchGitHubRepos(
  githubAuthManager: GitHubAuthManager,
  query: string,
) {
  if (!githubAuthManager.authenticated) return [];
  if (!query || query.length < 2) return githubAuthManager.listUserRepos();
  return githubAuthManager.searchRepos(query);
}

/** Get PR status for a session (returns null if no PR or not authenticated). */
export async function getPrStatus(
  githubAuthManager: GitHubAuthManager,
  git: GitManager,
  remoteUrl?: string,
) {
  if (!githubAuthManager.authenticated) return null;

  const resolved = await resolveGitHubRemote(git, remoteUrl);
  if ("error" in resolved) return null;

  const head = await git.getCurrentBranch();
  const pr = await githubAuthManager.findPullRequest(resolved.owner, resolved.repo, head);
  if (!pr) return null;

  const stats = await git.diffStatVsBranch(pr.base);
  const checks = await githubAuthManager.getCheckStatus(resolved.owner, resolved.repo, head);

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
  remoteUrl?: string,
): Promise<{ success: boolean; url?: string; number?: number; message?: string }> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");
  const trimmedTitle = title.trim();
  const trimmedBase = base.trim();
  if (!trimmedTitle) throw new ServiceError(400, "PR title is required");
  if (trimmedTitle.length > 256) throw new ServiceError(400, "PR title too long (max 256 characters)");
  if (!trimmedBase) throw new ServiceError(400, "Base branch is required");

  const resolved = await resolveGitHubRemote(git, remoteUrl);
  if ("error" in resolved) throw new ServiceError(400, resolved.error);

  const head = await git.getCurrentBranch();
  const result = await githubAuthManager.createPullRequest({
    owner: resolved.owner,
    repo: resolved.repo,
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
  remoteUrl?: string,
): Promise<{ success: boolean; message: string; autoMergeEnabled?: boolean }> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");

  const resolved = await resolveGitHubRemote(git, remoteUrl);
  if ("error" in resolved) return { success: false, message: resolved.error };

  const head = await git.getCurrentBranch();
  const pr = await githubAuthManager.findPullRequest(resolved.owner, resolved.repo, head);
  if (!pr) return { success: false, message: "No active PR for current branch" };

  const mergeMethod = (method || "merge") as "merge" | "squash" | "rebase";
  const result = await githubAuthManager.mergePullRequest(resolved.owner, resolved.repo, pr.number, mergeMethod);

  if (result.success) return { success: true, message: "Pull request merged" };

  // If merge failed because checks are pending, enable auto-merge
  const checks = await githubAuthManager.getCheckStatus(resolved.owner, resolved.repo, head);
  if (checks.state === "pending") {
    const graphqlMethod = mergeMethod === "merge" ? "MERGE" as const : mergeMethod === "squash" ? "SQUASH" as const : "REBASE" as const;
    const autoResult = await githubAuthManager.enableAutoMerge(resolved.owner, resolved.repo, pr.number, graphqlMethod);
    return { success: autoResult.success, message: autoResult.message, autoMergeEnabled: autoResult.success };
  }

  return { success: false, message: result.message };
}

/** Generate a PR description using the agent's generateText capability. */
export async function generatePrDescription(
  git: GitManager,
  generateText: (prompt: string, cwd: string) => Promise<string>,
  sessionDir: string,
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

/** One-click PR creation — push, generate description, create PR. */
export async function quickCreatePr(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  chatHistoryManager: ChatHistoryManager,
  generateText: (prompt: string, cwd: string) => Promise<string>,
  sessionId: string,
  sessionTitle: string,
  sessionDir: string,
  remoteUrl?: string,
): Promise<{
  number: number;
  url: string;
  title: string;
  baseBranch: string;
  headBranch: string;
  insertions: number;
  deletions: number;
}> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");

  const resolved = await resolveGitHubRemote(git, remoteUrl);
  if ("error" in resolved) throw new ServiceError(400, resolved.error);

  const head = await git.getCurrentBranch();

  // Check if there's already a PR for this branch
  const existingPr = await githubAuthManager.findPullRequest(resolved.owner, resolved.repo, head);
  if (existingPr) {
    const stats = await git.diffStatVsBranch(existingPr.base);
    return {
      number: existingPr.number,
      url: existingPr.url,
      title: existingPr.title,
      baseBranch: existingPr.base,
      headBranch: head,
      insertions: stats.insertions,
      deletions: stats.deletions,
    };
  }

  // Push the branch
  try {
    await git.push("origin", head);
  } catch (err) {
    const msg = getErrorMessage(err);
    if (msg.includes("workflow")) {
      throw new ServiceError(403,
        "Your GitHub token is missing the `workflow` scope, which is required because this branch modifies GitHub Actions workflow files.\n" +
        "Please update your token at https://github.com/settings/tokens to include the `workflow` scope, then reconnect.");
    }
    throw new ServiceError(500, `Push failed: ${msg}`);
  }

  // Detect base branch (main or master)
  const remoteBranches = await git.listRemoteBranches();
  const baseBranch = remoteBranches.includes("main") ? "main" :
    remoteBranches.includes("master") ? "master" :
    remoteBranches[0] ?? "main";

  // Generate title from session title
  const title = sessionTitle || head;

  // Generate description from conversation context
  const description = await generatePrDescriptionFromContext(
    git, chatHistoryManager, generateText, sessionId, baseBranch, sessionDir,
  );

  // Create PR
  const result = await githubAuthManager.createPullRequest({
    owner: resolved.owner,
    repo: resolved.repo,
    title,
    body: description,
    head,
    base: baseBranch,
  });

  if (!result.success || !result.url || !result.number) {
    throw new ServiceError(500, result.message ?? "Failed to create pull request");
  }

  const stats = await git.diffStatVsBranch(baseBranch);

  return {
    number: result.number,
    url: result.url,
    title,
    baseBranch,
    headBranch: head,
    insertions: stats.insertions,
    deletions: stats.deletions,
  };
}

/** Generate a conversation-aware PR description. */
async function generatePrDescriptionFromContext(
  git: GitManager,
  chatHistoryManager: ChatHistoryManager,
  generateText: (prompt: string, cwd: string) => Promise<string>,
  sessionId: string,
  baseBranch: string,
  sessionDir: string,
): Promise<string> {
  try {
    const messages = chatHistoryManager.load(sessionId);
    const firstUserMsg = messages.find((m) => m.role === "user")?.text ?? "";

    // Build conversation excerpt (last N exchanges, ~2000 chars)
    const exchanges: string[] = [];
    let charCount = 0;
    for (let i = messages.length - 1; i >= 0 && charCount < 2000; i--) {
      const msg = messages[i];
      const prefix = msg.role === "user" ? "User" : "Assistant";
      const text = msg.text.slice(0, 500);
      exchanges.unshift(`${prefix}: ${text}`);
      charCount += text.length;
    }

    const log = await git.log(20);
    const diff = await git.diffSummary();

    // Get diff stat vs base branch
    let diffStatLine = "";
    try {
      const stats = await git.diffStatVsBranch(baseBranch);
      diffStatLine = `+${stats.insertions} -${stats.deletions}`;
    } catch { /* ignore */ }

    const prompt = [
      "Generate a pull request description for the following changes.",
      "",
      "## What the user asked for",
      `"${firstUserMsg.slice(0, 300)}"`,
      "",
      "## Key conversation exchanges",
      ...exchanges,
      "",
      "## Code changes",
      ...(diff.length > 0
        ? diff.map((f) => `- ${f.file} (+${f.insertions} -${f.deletions})`)
        : ["(no file-level diff available)"]),
      diffStatLine ? `Total: ${diffStatLine}` : "",
      "",
      "## Commit log",
      ...log.map((c) => `- ${c.message}`),
      "",
      "Write a concise GitHub PR description in markdown:",
      '1. A "## Summary" section (2-3 sentences explaining why)',
      '2. A "## Changes" section (bullet list of key changes)',
      '3. A "## Test plan" section (how to verify)',
      "Return ONLY the markdown description, no extra commentary.",
    ].join("\n");

    return await generateText(prompt, sessionDir);
  } catch (err) {
    console.warn("[pr] Failed to generate description:", err);
    // Fallback to basic description
    try {
      const log = await git.log(5);
      return [
        "## Summary",
        "Changes from ShipIt session.",
        "",
        "## Changes",
        ...log.map((c) => `- ${c.message}`),
      ].join("\n");
    } catch {
      return "Changes from ShipIt session.";
    }
  }
}

// ---- Auto-merge operations ----

/** Toggle auto-merge on/off for a session's PR. */
export async function toggleAutoMerge(
  githubAuth: GitHubAuthManager,
  prStatusPoller: PrStatusPoller,
  sessionId: string,
  enabled: boolean,
): Promise<{ enabled: boolean; mergeMethod: "squash" | "merge" | "rebase"; managed?: boolean } | { error: PrAutoMergeError }> {
  if (!githubAuth.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");

  const prStatus = prStatusPoller.getStatus(sessionId);
  if (!prStatus) throw new ServiceError(404, "No PR status found for this session");

  const urlMatch = /github\.com\/([^/]+)\/([^/]+)/.exec(prStatus.prUrl);
  if (!urlMatch) throw new ServiceError(400, "Cannot parse repository from PR URL");
  const [, owner, repo] = urlMatch;

  const autoMergeState = prStatusPoller.getAutoMergeState(sessionId);
  const mergeMethod = autoMergeState?.mergeMethod ?? "squash";

  if (enabled) {
    const graphqlMethod = mergeMethod === "merge" ? "MERGE" as const : mergeMethod === "squash" ? "SQUASH" as const : "REBASE" as const;
    const result = await githubAuth.enableAutoMerge(owner, repo, prStatus.prNumber, graphqlMethod);

    if (!result.success) {
      // Fallback: ShipIt-managed auto-merge when GitHub native isn't available
      const settingsUrl = `https://github.com/${owner}/${repo}/settings`;
      const branchSettingsUrl = `${settingsUrl}/branches`;

      prStatusPoller.setAutoMergeEnabled(sessionId, true);
      prStatusPoller.setAutoMergeManaged(sessionId, true, branchSettingsUrl);
      return { enabled: true, mergeMethod, managed: true };
    }

    prStatusPoller.setAutoMergeEnabled(sessionId, true);
    return { enabled: true, mergeMethod };
  } else {
    const currentState = prStatusPoller.getAutoMergeState(sessionId);
    // Skip GitHub API call if this was ShipIt-managed (nothing to disable on GitHub)
    if (!currentState?.managed) {
      await githubAuth.disableAutoMerge(owner, repo, prStatus.prNumber);
    }
    prStatusPoller.setAutoMergeEnabled(sessionId, false);
    return { enabled: false, mergeMethod };
  }
}

/** Update the preferred merge method for a session. */
export async function updateMergeMethod(
  githubAuth: GitHubAuthManager,
  prStatusPoller: PrStatusPoller,
  sessionId: string,
  method: "squash" | "merge" | "rebase",
): Promise<{ mergeMethod: "squash" | "merge" | "rebase" }> {
  const autoMergeState = prStatusPoller.getAutoMergeState(sessionId);
  prStatusPoller.setMergeMethod(sessionId, method);

  // If auto-merge is active, re-enable with the new method
  if (autoMergeState?.enabled) {
    const prStatus = prStatusPoller.getStatus(sessionId);
    if (prStatus) {
      const urlMatch = /github\.com\/([^/]+)\/([^/]+)/.exec(prStatus.prUrl);
      if (urlMatch) {
        const [, owner, repo] = urlMatch;
        await githubAuth.disableAutoMerge(owner, repo, prStatus.prNumber);
        const graphqlMethod = method === "merge" ? "MERGE" as const : method === "squash" ? "SQUASH" as const : "REBASE" as const;
        await githubAuth.enableAutoMerge(owner, repo, prStatus.prNumber, graphqlMethod);
      }
    }
  }

  return { mergeMethod: method };
}

/** Set GitHub token. Returns status and repos. */
export async function setGitHubToken(
  githubAuthManager: GitHubAuthManager,
  token: string,
): Promise<{
  status: GitHubStatus;
  repos: { fullName: string; description: string | null; private: boolean; defaultBranch: string; cloneUrl: string }[];
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
