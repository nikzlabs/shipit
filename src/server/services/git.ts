/**
 * Git mutation services — rollback, reject, remote, push, pull.
 */

import type { SessionManager } from "../sessions.js";
import type { GitManager } from "../git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import { ServiceError } from "./types.js";

/** Rollback to a specific commit. */
export async function gitRollback(
  git: GitManager,
  commitHash: string,
): Promise<{ commitHash: string }> {
  await git.rollback(commitHash);
  return { commitHash };
}

/** Reject (revert) changes, either all files or specific ones. */
export async function rejectChanges(
  git: GitManager,
  fromCommit: string,
  files: string[],
): Promise<{ revertedFiles: string[]; commitHash: string }> {
  if (!fromCommit) throw new ServiceError(400, "fromCommit is required");
  if (files.length === 0) {
    await git.rollback(fromCommit);
    return { revertedFiles: [], commitHash: fromCommit };
  }
  await git.checkoutFiles(fromCommit, files);
  const hash = await git.autoCommit(`Revert ${files.length} file(s)`);
  return { revertedFiles: files, commitHash: hash ?? fromCommit };
}

/** Add or update a git remote. Returns the updated remotes list. */
export async function setGitRemote(
  git: GitManager,
  sessionManager: SessionManager,
  sessionId: string,
  name: string,
  url: string,
): Promise<{ remotes: Array<{ name: string; url: string }> }> {
  if (!name.trim() || !url.trim()) throw new ServiceError(400, "Remote name and URL are required");
  await git.addRemote(name.trim(), url.trim());
  if (name.trim() === "origin") {
    sessionManager.setRemoteUrl(sessionId, url.trim());
  }
  const remotes = await git.getRemotes();
  return { remotes };
}

/** Git push. Returns result with success flag and message. */
export async function gitPush(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  remote?: string,
  branch?: string,
): Promise<{ success: boolean; message: string; branch: string }> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");
  const r = remote || "origin";
  const b = branch || undefined;
  const message = await git.push(r, b);
  const currentBranch = await git.getCurrentBranch();
  return { success: true, message, branch: currentBranch };
}

/** Git pull. Returns result with success flag and message. */
export async function gitPull(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  remote?: string,
  branch?: string,
): Promise<{ success: boolean; message: string }> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");
  const r = remote || "origin";
  const b = branch || undefined;
  const message = await git.pull(r, b);
  return { success: true, message };
}
