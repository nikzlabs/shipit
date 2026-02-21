import crypto from "node:crypto";
import path from "node:path";
import type { WsClientMessage } from "../types.js";
import type { HandlerContext } from "./types.js";
import { getErrorMessage } from "../validation.js";

type WsForkSession = Extract<WsClientMessage, { type: "fork_session" }>;
type WsMergeSession = Extract<WsClientMessage, { type: "merge_session" }>;

export async function handleForkSession(ctx: HandlerContext, msg: WsForkSession): Promise<void> {
  const branchName = typeof msg.branchName === "string" ? msg.branchName.trim() : "";
  if (!branchName) {
    ctx.send({ type: "error", message: "Branch name is required" });
    return;
  }
  // Validate git branch name: no spaces, no '..' or '~', no control chars
  if (/[\s~^:?*[\\]/.test(branchName) || branchName.includes("..")) {
    ctx.send({ type: "error", message: "Invalid branch name" });
    return;
  }
  const activeSessionDir = ctx.getActiveSessionDir();
  const activeAppSessionId = ctx.getActiveAppSessionId();
  if (!activeSessionDir || !activeAppSessionId) {
    ctx.send({ type: "error", message: "No active session to fork from" });
    return;
  }

  try {
    const activeSession = ctx.sessionManager.get(activeAppSessionId);

    // Determine which repo to create the worktree from:
    // - Repo-backed sessions: use the shared clone in /repos/
    // - Standalone sessions: use the session's own .git dir
    let gitDir: string;
    if (activeSession?.remoteUrl) {
      gitDir = ctx.getSharedRepoDir(activeSession.remoteUrl);
    } else {
      gitDir = activeSessionDir;
    }

    const newSessionId = crypto.randomUUID();
    const newSessionDir = path.join(ctx.sessionsRoot, newSessionId);

    const repoGit = ctx.createGitManager(gitDir);
    await repoGit.createWorktree(newSessionDir, branchName, msg.startPoint);

    // Apply identity & credentials to the worktree
    const worktreeGit = ctx.createGitManager(newSessionDir);
    const stored = ctx.credentialStore.getGitIdentity();
    if (stored) await worktreeGit.setIdentity(stored.name, stored.email);
    if (ctx.githubAuthManager.authenticated) {
      ctx.githubAuthManager.configureGitCredentials(newSessionDir);
    }

    // Track in session manager
    const title = `${activeSession?.title ?? "Session"} (${branchName})`;
    ctx.sessionManager.track(newSessionId, title, newSessionDir);
    ctx.sessionManager.setWorktreeInfo(newSessionId, {
      branch: branchName,
      sessionType: "worktree",
    });
    if (activeSession?.remoteUrl) {
      ctx.sessionManager.setRemoteUrl(newSessionId, activeSession.remoteUrl);
    }

    ctx.threadManager.init(newSessionId);

    const newSession = ctx.sessionManager.get(newSessionId)!;
    ctx.send({ type: "session_forked", session: newSession, parentSessionId: activeAppSessionId });
    ctx.send({ type: "session_list", sessions: ctx.sessionManager.list() });
    console.log("[server] Forked session:", newSessionId, "branch:", branchName);
  } catch (err) {
    ctx.send({ type: "error", message: `Failed to fork session: ${getErrorMessage(err)}` });
  }
}

export async function handleListWorktrees(ctx: HandlerContext): Promise<void> {
  const activeSessionDir = ctx.getActiveSessionDir();
  const activeAppSessionId = ctx.getActiveAppSessionId();
  if (!activeSessionDir || !activeAppSessionId) {
    ctx.send({ type: "worktree_list", worktrees: [] });
    return;
  }

  try {
    // Find all sessions sharing the same repo
    const activeSession = ctx.sessionManager.get(activeAppSessionId);
    const siblings = activeSession?.remoteUrl
      ? ctx.sessionManager.findAllByRemoteUrl(activeSession.remoteUrl)
      : [activeSession].filter(Boolean) as import("../types.js").SessionInfo[];

    const worktrees: Array<{ sessionId: string; branch: string; path: string }> = [];
    for (const s of siblings) {
      if (s.workspaceDir && s.branch) {
        worktrees.push({
          sessionId: s.id,
          branch: s.branch,
          path: s.workspaceDir,
        });
      }
    }

    ctx.send({ type: "worktree_list", worktrees });
  } catch (err) {
    ctx.send({ type: "error", message: `Failed to list worktrees: ${getErrorMessage(err)}` });
  }
}

export async function handleMergeSession(ctx: HandlerContext, msg: WsMergeSession): Promise<void> {
  const sourceSessionId = typeof msg.sourceSessionId === "string" ? msg.sourceSessionId.trim() : "";
  if (!sourceSessionId) {
    ctx.send({ type: "error", message: "Source session ID is required" });
    return;
  }
  const activeSessionDir = ctx.getActiveSessionDir();
  const activeAppSessionId = ctx.getActiveAppSessionId();
  if (!activeSessionDir || !activeAppSessionId) {
    ctx.send({ type: "error", message: "No active session to merge into" });
    return;
  }

  const sourceSession = ctx.sessionManager.get(sourceSessionId);
  if (!sourceSession) {
    ctx.send({ type: "error", message: "Source session not found" });
    return;
  }
  if (!sourceSession.branch) {
    ctx.send({ type: "error", message: "Source session has no branch (not a worktree)" });
    return;
  }

  try {
    const git = ctx.getActiveGitManager();
    const result = await git.merge(sourceSession.branch);

    if (result.success) {
      ctx.send({
        type: "merge_result",
        success: true,
        message: `Merged branch '${sourceSession.branch}' successfully`,
      });
    } else {
      ctx.send({
        type: "merge_result",
        success: false,
        message: `Merge conflict on branch '${sourceSession.branch}'`,
        conflicts: result.conflicts,
      });
    }
  } catch (err) {
    ctx.send({ type: "error", message: `Failed to merge: ${getErrorMessage(err)}` });
  }
}
