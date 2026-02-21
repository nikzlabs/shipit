import type { WsClientMessage } from "../types.js";
import type { HandlerContext } from "./types.js";
import { getErrorMessage } from "../validation.js";

type WsGithubSetToken = Extract<WsClientMessage, { type: "github_set_token" }>;
type WsGithubPush = Extract<WsClientMessage, { type: "github_push" }>;
type WsGithubPull = Extract<WsClientMessage, { type: "github_pull" }>;
type WsGithubSetRemote = Extract<WsClientMessage, { type: "github_set_remote" }>;
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

export function handleGithubLogout(ctx: HandlerContext): void {
  ctx.githubAuthManager.clearCredentials();
  ctx.send({ type: "github_status", ...ctx.githubAuthManager.getStatus() });
  ctx.send({ type: "github_search_results", repos: [] });
}

