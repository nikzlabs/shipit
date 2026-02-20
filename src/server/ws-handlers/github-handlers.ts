import type { WsClientMessage } from "../types.js";
import type { HandlerContext } from "./types.js";
import { getErrorMessage } from "../validation.js";

import { GitManager } from "../git.js";

type WsGithubSetToken = Extract<WsClientMessage, { type: "github_set_token" }>;
type WsGithubPush = Extract<WsClientMessage, { type: "github_push" }>;
type WsGithubPull = Extract<WsClientMessage, { type: "github_pull" }>;
type WsGithubSetRemote = Extract<WsClientMessage, { type: "github_set_remote" }>;
type WsGithubSearchRepos = Extract<WsClientMessage, { type: "github_search_repos" }>;
type WsListRepoDocs = Extract<WsClientMessage, { type: "list_repo_docs" }>;
type WsGetRepoDoc = Extract<WsClientMessage, { type: "get_repo_doc" }>;

export async function handleGithubSetToken(ctx: HandlerContext, msg: WsGithubSetToken): Promise<void> {
  const token = typeof msg.token === "string" ? msg.token.trim() : "";
  if (!token) {
    ctx.send({ type: "error", message: "GitHub token cannot be empty" });
  } else {
    const success = await ctx.githubAuthManager.setToken(token);
    if (success) {
      // Configure credentials in the active session's git repo too
      const activeSessionDir = ctx.getActiveSessionDir();
      if (activeSessionDir) {
        ctx.githubAuthManager.configureGitCredentials(activeSessionDir);
      }
      ctx.send({ type: "github_status", ...ctx.githubAuthManager.getStatus() });
      // Auto-send user repos so the RepoSelector is populated immediately
      const repos = await ctx.githubAuthManager.listUserRepos();
      ctx.send({ type: "github_search_results", repos });
    } else {
      ctx.send({ type: "error", message: "Invalid GitHub token" });
    }
  }
}

export async function handleGithubGetStatus(ctx: HandlerContext): Promise<void> {
  ctx.send({ type: "github_status", ...ctx.githubAuthManager.getStatus() });
  // Auto-send user repos on connect so the RepoSelector is pre-populated
  if (ctx.githubAuthManager.authenticated) {
    const repos = await ctx.githubAuthManager.listUserRepos();
    ctx.send({ type: "github_search_results", repos });
  }
}

export async function handleGithubPush(ctx: HandlerContext, msg: WsGithubPush): Promise<void> {
  if (!ctx.githubAuthManager.authenticated) {
    ctx.send({ type: "error", message: "Not authenticated with GitHub" });
  } else {
    try {
      const git = ctx.getActiveGitManager();
      const remote = msg.remote || "origin";
      const branch = msg.branch || undefined;
      const message = await git.push(remote, branch);
      const currentBranch = await git.getCurrentBranch();
      ctx.send({ type: "github_push_result", success: true, message, branch: currentBranch });
    } catch (err) {
      ctx.send({ type: "github_push_result", success: false, message: `Push failed: ${getErrorMessage(err)}` });
    }
  }
}

export async function handleGithubPull(ctx: HandlerContext, msg: WsGithubPull): Promise<void> {
  if (!ctx.githubAuthManager.authenticated) {
    ctx.send({ type: "error", message: "Not authenticated with GitHub" });
  } else {
    try {
      const git = ctx.getActiveGitManager();
      const remote = msg.remote || "origin";
      const branch = msg.branch || undefined;
      const message = await git.pull(remote, branch);
      ctx.send({ type: "github_pull_result", success: true, message });
    } catch (err) {
      ctx.send({ type: "github_pull_result", success: false, message: `Pull failed: ${getErrorMessage(err)}` });
    }
  }
}

export async function handleGithubSetRemote(ctx: HandlerContext, msg: WsGithubSetRemote): Promise<void> {
  const name = typeof msg.name === "string" ? msg.name.trim() : "";
  const url = typeof msg.url === "string" ? msg.url.trim() : "";
  if (!name || !url) {
    ctx.send({ type: "error", message: "Remote name and URL are required" });
  } else {
    try {
      const git = ctx.getActiveGitManager();
      await git.addRemote(name, url);
      const activeAppSessionId = ctx.getActiveAppSessionId();
      if (name === "origin" && activeAppSessionId) {
        ctx.sessionManager.setRemoteUrl(activeAppSessionId, url);
      }
      const remotes = await git.getRemotes();
      ctx.send({ type: "github_remotes", remotes });
    } catch (err) {
      ctx.send({ type: "error", message: `Failed to set remote: ${getErrorMessage(err)}` });
    }
  }
}

export async function handleGithubGetRemotes(ctx: HandlerContext): Promise<void> {
  try {
    const git = ctx.getActiveGitManager();
    const remotes = await git.getRemotes();
    ctx.send({ type: "github_remotes", remotes });
  } catch (err) {
    ctx.send({ type: "error", message: `Failed to list remotes: ${getErrorMessage(err)}` });
  }
}

export function handleGithubLogout(ctx: HandlerContext): void {
  ctx.githubAuthManager.clearCredentials();
  ctx.send({ type: "github_status", ...ctx.githubAuthManager.getStatus() });
  ctx.send({ type: "github_search_results", repos: [] });
}

export async function handleGithubSearchRepos(ctx: HandlerContext, msg: WsGithubSearchRepos): Promise<void> {
  const query = typeof msg.query === "string" ? msg.query.trim() : "";
  if (!query || query.length < 2) {
    ctx.send({ type: "github_search_results", repos: [] });
    return;
  }

  const repos = await ctx.githubAuthManager.searchRepos(query);
  ctx.send({ type: "github_search_results", repos });
}

export async function handleGithubListBranches(ctx: HandlerContext): Promise<void> {
  try {
    const git = ctx.getActiveGitManager();
    const current = await git.getCurrentBranch();
    let remote: string[] = [];
    try {
      remote = await git.listRemoteBranches();
    } catch {
      // No remote branches (e.g., never pushed) — that's fine
    }
    ctx.send({ type: "github_branches", current, remote });
  } catch (err) {
    ctx.send({ type: "error", message: `Failed to list branches: ${getErrorMessage(err)}` });
  }
}

/** Parse owner/repo from a full name like "owner/repo". */
function parseRepoFullName(fullName: string): { owner: string; repo: string } | null {
  const trimmed = fullName.trim();
  // Accept "owner/repo" format or a GitHub URL
  const parsed = GitManager.parseGitHubRemote(`https://github.com/${trimmed}`);
  if (parsed) return parsed;
  const parts = trimmed.split("/");
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { owner: parts[0], repo: parts[1] };
  }
  return null;
}

export async function handleListRepoDocs(ctx: HandlerContext, msg: WsListRepoDocs): Promise<void> {
  const parsed = parseRepoFullName(msg.repoFullName);
  if (!parsed) {
    ctx.send({ type: "error", message: "Invalid repository name" });
    return;
  }

  try {
    const files = await ctx.githubAuthManager.listRepoMarkdownFiles(parsed.owner, parsed.repo);
    ctx.send({ type: "repo_doc_list", files });
  } catch (err) {
    ctx.send({ type: "error", message: `Failed to list repo docs: ${getErrorMessage(err)}` });
  }
}

export async function handleGetRepoDoc(ctx: HandlerContext, msg: WsGetRepoDoc): Promise<void> {
  const parsed = parseRepoFullName(msg.repoFullName);
  if (!parsed) {
    ctx.send({ type: "error", message: "Invalid repository name" });
    return;
  }

  const filePath = msg.path?.trim();
  if (!filePath) {
    ctx.send({ type: "error", message: "File path is required" });
    return;
  }

  try {
    const content = await ctx.githubAuthManager.getRepoFileContent(parsed.owner, parsed.repo, filePath);
    ctx.send({ type: "repo_doc_content", path: filePath, content });
  } catch (err) {
    ctx.send({ type: "error", message: `Failed to read repo doc: ${getErrorMessage(err)}` });
  }
}
