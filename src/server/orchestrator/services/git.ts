import type { SessionManager } from "../sessions.js";
import type { GitManager } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { FileDiff } from "../../shared/types.js";
import { scanFileTree } from "../../shared/file-tree.js";
import { createLfsBlobResolver, parseLfsPointer, type LfsBlobResolver } from "../git-lfs-blob.js";
import { stripRemoteUrlCredentials } from "../git-utils.js";
import type { GitRemoteCredentialResolver } from "../../shared/git-remote-credential.js";
import { ServiceError } from "./types.js";

// SVG remains text, with a client-side render toggle.
const DIFF_IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico",
]);

const MAX_DIFF_IMAGE_BYTES = 2 * 1_048_576;

function diffImageMime(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (!DIFF_IMAGE_EXTENSIONS.has(ext)) return null;
  if (ext === "jpg") return "image/jpeg";
  if (ext === "ico") return "image/x-icon";
  return `image/${ext}`;
}

function isSvgPath(filePath: string): boolean {
  return filePath.split(".").pop()?.toLowerCase() === "svg";
}

// Committed LFS blobs remain pointers even when the working tree is materialized.
async function diffBlobBytes(
  git: GitManager,
  ref: string,
  filePath: string,
  resolveLfs: LfsBlobResolver,
): Promise<Buffer | null> {
  const buf = await git.getFileBufferAtCommit(ref, filePath);
  if (!buf || buf.length === 0) return null;
  if (!parseLfsPointer(buf)) return buf;
  return resolveLfs(buf, filePath, MAX_DIFF_IMAGE_BYTES);
}

async function imageDataUri(
  git: GitManager,
  ref: string,
  filePath: string,
  resolveLfs: LfsBlobResolver,
): Promise<string> {
  const mime = diffImageMime(filePath);
  if (!mime) return "";
  const buf = await diffBlobBytes(git, ref, filePath, resolveLfs);
  if (!buf || buf.length === 0 || buf.length > MAX_DIFF_IMAGE_BYTES) return "";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

async function buildFileDiffContent(
  git: GitManager,
  fromRef: string,
  toRef: string,
  entry: { path: string; oldPath?: string },
  status: FileDiff["status"],
  isBinary: boolean,
  resolveLfs: LfsBlobResolver,
): Promise<{ oldContent: string; newContent: string; image: boolean; lfs?: boolean }> {
  const oldPath = status === "renamed" ? (entry.oldPath ?? entry.path) : entry.path;

  if (isBinary) {
    if (!diffImageMime(entry.path)) return { oldContent: "", newContent: "", image: false };
    const oldContent = status === "added" ? "" : await imageDataUri(git, fromRef, oldPath, resolveLfs);
    const newContent = status === "deleted" ? "" : await imageDataUri(git, toRef, entry.path, resolveLfs);
    return { oldContent, newContent, image: Boolean(oldContent || newContent) };
  }

  const oldRaw = status === "added" ? "" : await git.getFileAtCommit(fromRef, oldPath);
  const newRaw = status === "deleted" ? "" : await git.getFileAtCommit(toRef, entry.path);

  // Git reports ordinary LFS pointers as text, including pointers to raster images.
  const renderable = diffImageMime(entry.path) !== null || isSvgPath(entry.path);
  if (renderable && (parseLfsPointer(oldRaw) || parseLfsPointer(newRaw))) {
    const mime = diffImageMime(entry.path);
    const [oldContent, newContent] = await Promise.all([
      lfsMediaSide(git, fromRef, oldPath, oldRaw, mime, resolveLfs),
      lfsMediaSide(git, toRef, entry.path, newRaw, mime, resolveLfs),
    ]);
    // Keep image panes when resolution fails so the viewer can explain missing content.
    return { oldContent, newContent, image: mime !== null, lfs: true };
  }

  return { oldContent: oldRaw, newContent: newRaw, image: false };
}

async function lfsMediaSide(
  git: GitManager,
  ref: string,
  filePath: string,
  raw: string,
  mime: string | null,
  resolveLfs: LfsBlobResolver,
): Promise<string> {
  if (raw === "") return "";
  const pointer = parseLfsPointer(raw);
  if (!pointer && !mime) return raw;
  // Reread non-pointer raster bytes; the UTF-8 raw string cannot preserve them.
  const bytes = pointer
    ? await resolveLfs(raw, filePath, MAX_DIFF_IMAGE_BYTES)
    : await git.getFileBufferAtCommit(ref, filePath);
  if (!bytes || bytes.length === 0 || bytes.length > MAX_DIFF_IMAGE_BYTES) {
    // SVG can fall back to pointer text; raster panes must not render pointers as images.
    return mime ? "" : raw;
  }
  return mime ? `data:${mime};base64,${bytes.toString("base64")}` : bytes.toString("utf-8");
}

export async function getGitLog(git: GitManager) {
  return git.log();
}

export async function getGitRemotes(git: GitManager) {
  return git.getRemotes();
}

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

export async function getTurnDiff(
  git: GitManager,
  fromCommit: string,
  toCommit: string,
  // Session-identity LFS fetches cannot read the orchestrator's stored credential.
  resolveRemoteCredential?: GitRemoteCredentialResolver,
): Promise<{
  fromCommit: string;
  toCommit: string;
  files: FileDiff[];
  stats: { totalInsertions: number; totalDeletions: number; filesChanged: number };
}> {
  const changedFiles = await git.diffNameStatus(fromCommit, toCommit);
  const diffSummary = await git.diffSummary(`${fromCommit}...${toCommit}`);

  const statsMap = new Map<string, { insertions: number; deletions: number; binary: boolean }>();
  for (const f of diffSummary) {
    statsMap.set(f.file, { insertions: f.insertions, deletions: f.deletions, binary: f.binary });
  }

  const files: FileDiff[] = [];
  let totalInsertions = 0;
  let totalDeletions = 0;
  // Share the resolver's fetch budget across all files in this diff request.
  const resolveLfs = createLfsBlobResolver(git.dir, { resolveRemoteCredential });

  for (const entry of changedFiles) {
    const stats = statsMap.get(entry.path) ?? { insertions: 0, deletions: 0, binary: false };
    const isBinary = stats.binary;

    let status: FileDiff["status"];
    switch (entry.status) {
      case "A": status = "added"; break;
      case "D": status = "deleted"; break;
      case "R": status = "renamed"; break;
      default: status = "modified"; break;
    }

    const { oldContent, newContent, image, lfs } = await buildFileDiffContent(
      git, fromCommit, toCommit, entry, status, isBinary, resolveLfs,
    );

    totalInsertions += stats.insertions;
    totalDeletions += stats.deletions;

    files.push({
      path: entry.path,
      oldPath: entry.oldPath,
      status,
      insertions: stats.insertions,
      deletions: stats.deletions,
      binary: isBinary,
      image,
      lfs,
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

// origin/HEAD can name a deleted branch; require it in the caller's remote branch list.
export async function resolvePrBaseBranch(
  git: GitManager,
  remoteBranches: string[],
): Promise<string> {
  const detected = await git.getDefaultBranch();
  if (remoteBranches.includes(detected)) return detected;
  return remoteBranches.includes("main") ? "main"
    : remoteBranches.includes("master") ? "master"
    : remoteBranches[0] ?? "main";
}

// Share committed PR scope between the docs panel and notable-files strip.
export async function committedChangesVsBase(
  git: GitManager,
  baseBranch: string,
): Promise<{ status: string; path: string; oldPath?: string }[]> {
  const baseRef = await git.resolveBaseBranchRef(baseBranch);
  if (!baseRef) return [];
  const mergeBaseHash = await git.mergeBase(baseRef, "HEAD");
  if (!mergeBaseHash) return [];
  return git.diffNameStatus(mergeBaseHash, "HEAD");
}

export async function getSessionChangedPaths(
  git: GitManager,
  baseBranch: string,
): Promise<Set<string>> {
  const paths = new Set<string>();
  for (const entry of await committedChangesVsBase(git, baseBranch)) {
    paths.add(entry.path);
    if (entry.oldPath) paths.add(entry.oldPath);
  }
  return paths;
}

export async function getDiffVsBranch(
  git: GitManager,
  baseBranch: string,
  resolveRemoteCredential?: GitRemoteCredentialResolver,
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

  const statsMap = new Map<string, { insertions: number; deletions: number; binary: boolean }>();
  for (const f of diffSummary) {
    statsMap.set(f.file, { insertions: f.insertions, deletions: f.deletions, binary: f.binary });
  }

  const files: FileDiff[] = [];
  let totalInsertions = 0;
  let totalDeletions = 0;
  const resolveLfs = createLfsBlobResolver(git.dir, { resolveRemoteCredential });

  for (const entry of changedFiles) {
    const stats = statsMap.get(entry.path) ?? { insertions: 0, deletions: 0, binary: false };
    const isBinary = stats.binary;

    let status: FileDiff["status"];
    switch (entry.status) {
      case "A": status = "added"; break;
      case "D": status = "deleted"; break;
      case "R": status = "renamed"; break;
      default: status = "modified"; break;
    }

    const { oldContent, newContent, image, lfs } = await buildFileDiffContent(
      git, mergeBaseHash, headHash, entry, status, isBinary, resolveLfs,
    );

    totalInsertions += stats.insertions;
    totalDeletions += stats.deletions;

    files.push({
      path: entry.path,
      oldPath: entry.oldPath,
      status,
      insertions: stats.insertions,
      deletions: stats.deletions,
      binary: isBinary,
      image,
      lfs,
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

export async function gitRollback(
  git: GitManager,
  commitHash: string,
): Promise<{ commitHash: string }> {
  await git.rollback(commitHash);
  return { commitHash };
}

export async function setGitRemote(
  git: GitManager,
  sessionManager: SessionManager,
  sessionId: string,
  name: string,
  url: string,
): Promise<{ remotes: { name: string; url: string }[] }> {
  if (!name.trim() || !url.trim()) throw new ServiceError(400, "Remote name and URL are required");
  const cleanUrl = stripRemoteUrlCredentials(url);
  if (cleanUrl !== url.trim()) {
    console.warn(
      `[git] Dropped the credential embedded in the remote URL for ${name.trim()} — ShipIt never records `
      + "one in a git config; access is supplied by the GitHub connection at fetch time.",
    );
  }
  await git.addRemote(name.trim(), cleanUrl);
  if (name.trim() === "origin") {
    sessionManager.setRemoteUrl(sessionId, cleanUrl);
  }
  const remotes = await git.getRemotes();
  return { remotes };
}

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

export async function rebaseAbort(git: GitManager): Promise<void> {
  await git.rebaseAbort();
}

export type PushFailureClass =
  | "non-fast-forward"
  | "invalid-refspec"
  | "auth"
  | "lfs"
  | "remote-rejected"
  | "network"
  | "unknown";

// Match specific causes first: LFS overlaps remote rejection, and auth overlaps
// network errors. The generic "failed to push some refs" summary identifies neither.
const PUSH_FAILURE_PATTERNS: readonly (readonly [PushFailureClass, RegExp])[] = [
  ["lfs", /GH008|unknown Git LFS object|LFS upload|lfs\.locksverify|missing (?:a few |some )?(?:Git )?LFS object/i],
  [
    // Require HTTP context: progress counts such as (403/403) are not auth errors.
    "auth",
    /Authentication failed|could not read (?:Username|Password)|terminal prompts disabled|Invalid username or (?:password|token)|Bad credentials|Password authentication is not supported|(?:HTTP(?:\/[\d.]+)?\s+|returned error:\s*|status(?:\s+code)?:?\s*)40[13]\b|\b40[13]\b[^\n]{0,30}(?:Forbidden|Unauthorized)|Permission to .+ denied|Repository not found|needs the .*workflow.* scope|refusing to allow (?:a|an) .* to create or update .*workflow/i,
  ],
  ["remote-rejected", /\[remote rejected\]|pre-receive hook declined|protected branch|push declined/i],
  [
    "non-fast-forward",
    /non-fast-forward|\[rejected\]|\(fetch first\)|\(stale info\)|Updates were rejected because/i,
  ],
  ["invalid-refspec", /not a full refname|src refspec .+ does not match any|matches more than one/i],
  [
    "network",
    /Could not resolve host|Connection (?:timed out|refused|reset)|The remote end hung up|RPC failed|early EOF|Operation timed out|unable to access '/i,
  ],
];

export function classifyPushFailure(err: unknown): PushFailureClass {
  const msg = err instanceof Error ? err.message : String(err);
  for (const [cls, pattern] of PUSH_FAILURE_PATTERNS) {
    if (pattern.test(msg)) return cls;
  }
  return "unknown";
}

export function isNonFastForwardError(err: unknown): boolean {
  return classifyPushFailure(err) === "non-fast-forward";
}

// Only ancestry and refspec failures can be caused by an in-flight history rewrite.
export function isRewriteWindowPushFailure(err: unknown): boolean {
  const cls = classifyPushFailure(err);
  return cls === "non-fast-forward" || cls === "invalid-refspec";
}
