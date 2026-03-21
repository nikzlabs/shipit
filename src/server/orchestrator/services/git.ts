/**
 * Git services — reads (log, diff, remotes, branches) and mutations
 * (rollback, reject, remote, push, pull).
 */

import type { SessionManager } from "../sessions.js";
import type { GitManager } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { FileDiff } from "../../shared/types.js";
import { scanFileTree } from "../../shared/file-tree.js";
import { ServiceError } from "./types.js";

// ---- Read operations ----

/** Get git log for a session. */
export async function getGitLog(git: GitManager) {
  return git.log();
}

/** Get git diff between two commits (file list with name/status). */
export async function getGitDiffNameStatus(git: GitManager, from: string, to: string) {
  return git.diffNameStatus(from, to);
}

/** Get git remotes. */
export async function getGitRemotes(git: GitManager) {
  return git.getRemotes();
}

/** Get git branches (current + remote). */
export async function getGitBranches(git: GitManager) {
  const current = await git.getCurrentBranch();
  let remote: string[] = [];
  try {
    remote = await git.listRemoteBranches();
  } catch {
    // No remote branches — that's fine
  }
  return { current, remote };
}

/** Get workspace state (git log + file tree) for a session. */
export async function getWorkspaceState(
  git: GitManager,
  dir: string,
): Promise<{ gitLog: Awaited<ReturnType<typeof getGitLog>>; fileTree: Awaited<ReturnType<typeof scanFileTree>> }> {
  const [gitLog, fileTree] = await Promise.all([
    getGitLog(git),
    scanFileTree(dir),
  ]);
  return { gitLog, fileTree };
}

/** Get the full turn diff between two commits (file contents + stats). */
export async function getTurnDiff(
  git: GitManager,
  fromCommit: string,
  toCommit: string,
): Promise<{
  fromCommit: string;
  toCommit: string;
  files: FileDiff[];
  stats: { totalInsertions: number; totalDeletions: number; filesChanged: number };
}> {
  const changedFiles = await git.diffNameStatus(fromCommit, toCommit);
  const diffSummary = await git.diffSummary();

  const statsMap = new Map<string, { insertions: number; deletions: number }>();
  for (const f of diffSummary) {
    statsMap.set(f.file, { insertions: f.insertions, deletions: f.deletions });
  }

  const files: FileDiff[] = [];
  let totalInsertions = 0;
  let totalDeletions = 0;

  for (const entry of changedFiles) {
    const stats = statsMap.get(entry.path) ?? { insertions: 0, deletions: 0 };
    const isBinary = stats.insertions === 0 && stats.deletions === 0 && entry.status !== "D";

    let status: FileDiff["status"];
    switch (entry.status) {
      case "A": status = "added"; break;
      case "D": status = "deleted"; break;
      case "R": status = "renamed"; break;
      default: status = "modified"; break;
    }

    let oldContent = "";
    let newContent = "";

    if (!isBinary) {
      if (status === "deleted") {
        oldContent = await git.getFileAtCommit(fromCommit, entry.path);
      } else if (status === "added") {
        newContent = await git.getFileAtCommit(toCommit, entry.path);
      } else if (status === "renamed") {
        oldContent = await git.getFileAtCommit(fromCommit, entry.oldPath ?? entry.path);
        newContent = await git.getFileAtCommit(toCommit, entry.path);
      } else {
        oldContent = await git.getFileAtCommit(fromCommit, entry.path);
        newContent = await git.getFileAtCommit(toCommit, entry.path);
      }
    }

    totalInsertions += stats.insertions;
    totalDeletions += stats.deletions;

    files.push({
      path: entry.path,
      oldPath: entry.oldPath,
      status,
      insertions: stats.insertions,
      deletions: stats.deletions,
      binary: isBinary,
      oldContent,
      newContent,
    });
  }

  return {
    fromCommit,
    toCommit,
    files,
    stats: { totalInsertions, totalDeletions, filesChanged: files.length },
  };
}

/** Get full diff between current HEAD and a base branch (for PR diffs). */
export async function getDiffVsBranch(
  git: GitManager,
  baseBranch: string,
): Promise<{
  fromCommit: string;
  toCommit: string;
  files: FileDiff[];
  stats: { totalInsertions: number; totalDeletions: number; filesChanged: number };
}> {
  const baseRef = await git.resolveBaseBranchRef(baseBranch);
  if (!baseRef) throw new ServiceError(400, `Cannot resolve base branch: ${baseBranch}`);

  const mergeBaseHash = await git.mergeBase(baseRef, "HEAD");
  if (!mergeBaseHash) throw new ServiceError(400, `Cannot find merge-base between ${baseRef} and HEAD`);

  const headHash = await git.getHeadHash();
  if (!headHash) throw new ServiceError(400, "No commits in repository");

  const changedFiles = await git.diffNameStatus(mergeBaseHash, "HEAD");
  const diffSummary = await git.diffSummary(`${mergeBaseHash}...HEAD`);

  const statsMap = new Map<string, { insertions: number; deletions: number }>();
  for (const f of diffSummary) {
    statsMap.set(f.file, { insertions: f.insertions, deletions: f.deletions });
  }

  const files: FileDiff[] = [];
  let totalInsertions = 0;
  let totalDeletions = 0;

  for (const entry of changedFiles) {
    const stats = statsMap.get(entry.path) ?? { insertions: 0, deletions: 0 };
    const isBinary = stats.insertions === 0 && stats.deletions === 0 && entry.status !== "D";

    let status: FileDiff["status"];
    switch (entry.status) {
      case "A": status = "added"; break;
      case "D": status = "deleted"; break;
      case "R": status = "renamed"; break;
      default: status = "modified"; break;
    }

    let oldContent = "";
    let newContent = "";

    if (!isBinary) {
      if (status === "deleted") {
        oldContent = await git.getFileAtCommit(mergeBaseHash, entry.path);
      } else if (status === "added") {
        newContent = await git.getFileAtCommit(headHash, entry.path);
      } else if (status === "renamed") {
        oldContent = await git.getFileAtCommit(mergeBaseHash, entry.oldPath ?? entry.path);
        newContent = await git.getFileAtCommit(headHash, entry.path);
      } else {
        oldContent = await git.getFileAtCommit(mergeBaseHash, entry.path);
        newContent = await git.getFileAtCommit(headHash, entry.path);
      }
    }

    totalInsertions += stats.insertions;
    totalDeletions += stats.deletions;

    files.push({
      path: entry.path,
      oldPath: entry.oldPath,
      status,
      insertions: stats.insertions,
      deletions: stats.deletions,
      binary: isBinary,
      oldContent,
      newContent,
    });
  }

  return {
    fromCommit: mergeBaseHash,
    toCommit: headHash,
    files,
    stats: { totalInsertions, totalDeletions, filesChanged: files.length },
  };
}

// ---- Mutation operations ----

/** Rollback to a specific commit. */
export async function gitRollback(
  git: GitManager,
  commitHash: string,
): Promise<{ commitHash: string }> {
  await git.rollback(commitHash);
  return { commitHash };
}

/** Add or update a git remote. Returns the updated remotes list. */
export async function setGitRemote(
  git: GitManager,
  sessionManager: SessionManager,
  sessionId: string,
  name: string,
  url: string,
): Promise<{ remotes: { name: string; url: string }[] }> {
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
