/**
 * Git services — reads (log, diff, remotes, branches) and mutations
 * (rollback, reject, remote, push, pull, rebase, force-push).
 */

import type { SessionManager } from "../sessions.js";
import type { GitManager } from "../../shared/git.js";
import type { RebaseConflictFile } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { FileDiff } from "../../shared/types.js";
import { scanFileTree } from "../../shared/file-tree.js";
import { createLfsBlobResolver, parseLfsPointer, type LfsBlobResolver } from "../git-lfs-blob.js";
import { stripRemoteUrlCredentials } from "../git-utils.js";
import type { GitRemoteCredentialResolver } from "../../shared/git-remote-credential.js";
import { ServiceError } from "./types.js";

// ---- Image diff support ----

/**
 * Raster image extensions whose old/new bytes we embed into the diff so the
 * viewer can render the two variants side by side. SVG is deliberately absent:
 * it's text, so it flows through the normal text-diff path and gets a
 * render toggle client-side.
 */
const DIFF_IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico",
]);

/** Per-side cap for an embedded image blob. Larger images fall back to the
 *  "binary file" placeholder rather than bloating the diff payload. */
const MAX_DIFF_IMAGE_BYTES = 2 * 1_048_576;

/** MIME type for a renderable image path, or `null` if it isn't one we embed. */
function diffImageMime(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (!DIFF_IMAGE_EXTENSIONS.has(ext)) return null;
  if (ext === "jpg") return "image/jpeg";
  if (ext === "ico") return "image/x-icon";
  return `image/${ext}`;
}

/** SVG is text, so it never reaches the binary branch — but it can still be
 *  LFS-tracked, in which case the "text" is a pointer stub. */
function isSvgPath(filePath: string): boolean {
  return filePath.split(".").pop()?.toLowerCase() === "svg";
}

/**
 * Real bytes for one side of a diff, following an LFS pointer when the blob is
 * one. Diff blobs are read from the object database, not the working tree, so in
 * an LFS repo they are *always* pointer stubs no matter what provisioning pulled
 * — see the `git-lfs-blob.ts` docstring.
 */
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

/** Load an image blob at a ref as a base64 `data:` URI, or "" if absent/too big. */
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

/**
 * Resolve the old/new content for one changed file, shared by `getTurnDiff` and
 * `getDiffVsBranch` (which differ only in the refs they diff). For text files
 * the content is the UTF-8 blob; for binary *images* it's base64 `data:` URIs
 * (and `image: true`); other binaries get empty content (`image: false`) and
 * render as the placeholder.
 *
 * LFS-tracked images arrive on the **text** branch, not the binary one: the
 * conventional `.gitattributes` line leaves git sniffing an ASCII pointer stub,
 * so git reports an ordinary +2/-2 text diff and the viewer would show a sha256
 * where the picture should be. When either side is a pointer we swap in the real
 * content — as a `data:` URI for rasters, as source text for SVG — and flag the
 * file `lfs` so the viewer can say so on a side it couldn't fetch.
 */
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

  const renderable = diffImageMime(entry.path) !== null || isSvgPath(entry.path);
  if (renderable && (parseLfsPointer(oldRaw) || parseLfsPointer(newRaw))) {
    const mime = diffImageMime(entry.path);
    const [oldContent, newContent] = await Promise.all([
      lfsMediaSide(git, fromRef, oldPath, oldRaw, mime, resolveLfs),
      lfsMediaSide(git, toRef, entry.path, newRaw, mime, resolveLfs),
    ]);
    // `image` even when both sides failed to resolve: a raster gets image panes
    // that say *why* they're empty, which beats an empty Monaco text diff — and
    // the one thing we must never do here is fall back to diffing the pointers.
    return { oldContent, newContent, image: mime !== null, lfs: true };
  }

  return { oldContent: oldRaw, newContent: newRaw, image: false };
}

/**
 * One side of an LFS-tracked media file, as the viewer wants it: a `data:` URI
 * for a raster, source text for an SVG.
 *
 * Handles the mixed case too — a file only *just* converted to LFS has a pointer
 * on one side and a real blob on the other — by re-reading the non-pointer side
 * as bytes. `oldRaw`/`newRaw` came from `git show`, which decoded them as UTF-8;
 * that's fine for SVG and would corrupt a PNG.
 *
 * The two media kinds fail differently, on purpose. A raster that can't be
 * fetched degrades to `""` and the viewer labels the pane "(Git LFS content
 * unavailable)" — a `data:` URI built from a pointer would just be a broken
 * image. An SVG keeps its pointer text, because SVG still has a working text
 * diff to fall back to and an empty Monaco pane would explain nothing.
 */
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
  if (!pointer && !mime) return raw; // real SVG source — already text
  const bytes = pointer
    ? await resolveLfs(raw, filePath, MAX_DIFF_IMAGE_BYTES)
    : await git.getFileBufferAtCommit(ref, filePath);
  if (!bytes || bytes.length === 0 || bytes.length > MAX_DIFF_IMAGE_BYTES) {
    return mime ? "" : raw;
  }
  return mime ? `data:${mime};base64,${bytes.toString("base64")}` : bytes.toString("utf-8");
}

// ---- Rebase types ----

export type RebaseFlowResult =
  | { status: "up_to_date" }
  | { status: "rebased"; baseRef: string }
  | { status: "conflicts"; conflicts: RebaseConflictFile[]; baseRef: string };

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
  // docs/266-orchestrator-git-trust-boundary E3 — the LFS smudge below runs on a session workspace, so under E1
  // it has dropped uid and cannot read the orchestrator's PAT. Without this a
  // private repo's LFS assets render as pointer text.
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
  // One resolver per diff request: its network-fetch budget is what bounds how
  // long an LFS repo can hold this response open.
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

/**
 * The branch a new PR should target — the remote's actual default branch.
 *
 * Prefers {@link GitManager.getDefaultBranch} (reads `origin/HEAD`, so it knows
 * `trunk` and `develop`, not just `main`/`master`), but only accepts the answer
 * when that branch genuinely exists on the remote: `origin/HEAD` can be stale or
 * point at a branch since deleted, and opening a PR against a nonexistent base
 * is a hard GitHub error. Otherwise it falls back to the historical heuristic —
 * `main`, then `master`, then whatever the remote's first branch is.
 *
 * `remoteBranches` is passed in rather than fetched because every caller has
 * already listed them for its own checks.
 */
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

/**
 * Committed name-status changes for `merge-base(base, HEAD)..HEAD` — i.e.
 * exactly what this branch changed vs its base (the symmetric three-dot diff,
 * not a two-dot `base..HEAD` that would pull in files moved on the base since
 * the branch point). This is the SINGLE source of truth for "what did this
 * branch change", shared by the Docs panel's changed-in-session flag
 * ({@link getSessionChangedPaths}) and the PR card's notable-files strip
 * (`notableFilesForBranch`) so the two surfaces can never drift.
 *
 * Committed-only by design: it mirrors the PR's diff (uncommitted working-tree
 * edits aren't in the PR yet), and the per-turn auto-commit closes the gap
 * within a turn. Best-effort — returns `[]` when the base or merge-base can't
 * be resolved (e.g. a brand-new local project), so callers flag nothing rather
 * than everything.
 */
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

/**
 * Repo-relative paths changed on this branch vs its base — the authoritative
 * "what did the agent touch this session" signal that drives the Docs panel's
 * "Modified in this session" group. Far more reliable than file mtimes, which
 * git rewrites on every checkout/fetch/reset (false positives for untouched
 * files).
 *
 * A thin projection of {@link committedChangesVsBase} (paths only, including a
 * rename's old path), so it stays byte-for-byte in step with the PR card's
 * strip — both diff the same merge-base range against the same base branch.
 */
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

/** Get full diff between current HEAD and a base branch (for PR diffs). */
export async function getDiffVsBranch(
  git: GitManager,
  baseBranch: string,
  /** docs/266-orchestrator-git-trust-boundary E3 — see {@link getTurnDiff}. */
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

// ---- Mutation operations ----

/** Rollback to a specific commit. */
export async function gitRollback(
  git: GitManager,
  commitHash: string,
): Promise<{ commitHash: string }> {
  await git.rollback(commitHash);
  return { commitHash };
}

/**
 * Add or update a git remote. Returns the updated remotes list.
 *
 * The URL is recorded credential-free (docs/262 req 19). This is the one place
 * a user hands ShipIt an arbitrary remote string, and it writes it straight
 * into the session's own `.git/config` — `/project/.git/config` inside the
 * container, readable by the agent and by every plugin CLI and plugin service.
 * Only http(s) userinfo is removed; the other shapes git accepts are still
 * handled at the cross-session display boundary
 * (`sanitizeRemoteUrlForInventory`).
 */
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

// ---- Rebase operations ----

/**
 * Rebase the session's branch onto the latest base branch.
 * Fetches upstream, attempts rebase. On clean rebase, returns "rebased".
 * On conflicts, returns them for agent resolution.
 */
export async function rebaseOntoBase(
  git: GitManager,
  baseBranch: string,
): Promise<RebaseFlowResult> {
  // 1. Fetch latest from remote
  await git.fetch("origin");

  // 2. Resolve the base branch ref
  const baseRef = await git.resolveBaseBranchRef(baseBranch);
  if (!baseRef) throw new ServiceError(400, `Cannot resolve base branch: ${baseBranch}`);

  // 3. Check if rebase is needed
  const isUpToDate = await git.isAncestor(baseRef, "HEAD");
  if (isUpToDate) {
    return { status: "up_to_date" };
  }

  // 4. Attempt rebase
  const result = await git.rebase(baseRef);

  if (result.status === "clean") {
    return { status: "rebased", baseRef };
  }

  // 5. Conflicts — return them (caller will delegate to agent, then continue)
  return {
    status: "conflicts",
    conflicts: result.conflicts,
    baseRef,
  };
}

/** Force push after a successful rebase. Requires GitHub auth. */
export async function forcePushAfterRebase(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
): Promise<{ success: boolean; message: string; branch: string }> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");
  const message = await git.forcePush();
  const branch = await git.getCurrentBranch();
  return { success: true, message, branch };
}

/** Abort an in-progress rebase. */
export async function rebaseAbort(git: GitManager): Promise<void> {
  await git.rebaseAbort();
}

/**
 * Why a `git push` failed, as far as its output says.
 *
 * ## Why a *classification* and not a boolean
 *
 * {@link isNonFastForwardError} used to match the bare substring
 * `failed to push some refs`, which git emits on essentially EVERY push failure
 * — the summary line, not the reason. So an unrelated failure was reported to
 * the user as "branch has diverged from remote. Rebase needed to update.", and
 * the remedy that advice names cannot fix a rejection that was never about
 * ancestry. Every later turn then failed identically, with the raw stderr
 * recorded nowhere an operator could read it.
 *
 * That has now happened twice, in two different shapes:
 *
 *  - **2026-08-17, session 590c19aa** — an auto-push fired mid-rebase, when the
 *    workspace is on a detached HEAD, so it ran `git push origin HEAD` and git
 *    refused the refspec outright (*"not a full refname"*). Reported as a
 *    divergence; the branch was fine throughout. See
 *    `auto-push-scheduler.ts`'s module docstring for the deferral this drove.
 *  - **2026-08-18, session b77e02fe** — the remote rejected the push with
 *    `GH008: unknown Git LFS object`, because the orchestrator's hook-less push
 *    sent LFS pointers without their objects (`shared/git-lfs-push.ts`).
 *    `git ls-remote` proved the remote tip was ShipIt's own last push and
 *    `git merge-base --is-ancestor` exited 0 — there was no divergence to
 *    rebase away, and two turns' commits stayed local across 25 minutes.
 *
 * So a class is only assigned on a marker that actually names the failure. The
 * catch-all is `unknown`, which callers report verbatim rather than
 * interpreting.
 */
export type PushFailureClass =
  /** The remote ref is not an ancestor of what we pushed — a real divergence. */
  | "non-fast-forward"
  /** The refspec never named a pushable ref (detached HEAD, deleted branch). */
  | "invalid-refspec"
  /** The credential was missing, refused, or lacks the scope. */
  | "auth"
  /** The remote refused the push because LFS objects are missing (`GH008`). */
  | "lfs"
  /** A server-side hook or branch protection declined an otherwise valid push. */
  | "remote-rejected"
  /** The push never reached a server. */
  | "network"
  /** No marker matched — report the message, do not interpret it. */
  | "unknown";

/**
 * Ordered most-specific first. Order is load-bearing where the shapes overlap:
 * a GH008 rejection also prints `[remote rejected] … (pre-receive hook
 * declined)`, and an auth failure also prints `unable to access '…'`.
 *
 * Note what is deliberately absent from every pattern: `failed to push some
 * refs`. It is git's summary line, present on all of these, so matching it can
 * only ever produce the misreport above.
 */
const PUSH_FAILURE_PATTERNS: readonly (readonly [PushFailureClass, RegExp])[] = [
  ["lfs", /GH008|unknown Git LFS object|LFS upload|lfs\.locksverify|missing (?:a few |some )?(?:Git )?LFS object/i],
  [
    // A bare `\b40[13]\b` was tried and is WRONG: git's own progress output
    // carries free-standing numbers, and `remote: Resolving deltas: 100%
    // (403/403), done.` — which a large push prints on its way to a perfectly
    // ordinary non-fast-forward rejection — has word boundaries on both sides
    // of that `403`. An HTTP status only counts where something says it is one,
    // which is the discipline `git-utils.ts`'s `isGitAuthError` already uses.
    "auth",
    /Authentication failed|could not read (?:Username|Password)|terminal prompts disabled|Invalid username or (?:password|token)|Bad credentials|Password authentication is not supported|(?:HTTP(?:\/[\d.]+)?\s+|returned error:\s*|status(?:\s+code)?:?\s*)40[13]\b|\b40[13]\b[^\n]{0,30}(?:Forbidden|Unauthorized)|Permission to .+ denied|Repository not found|needs the .*workflow.* scope|refusing to allow (?:a|an) .* to create or update .*workflow/i,
  ],
  ["remote-rejected", /\[remote rejected\]|pre-receive hook declined|protected branch|push declined/i],
  [
    // `[rejected]` needs no anchor: `[remote rejected]` — the hook/GH008 shape,
    // already matched above — does not contain that literal, and the two forms
    // git prints put different things between the `!` and the bracket
    // (`! [rejected] main -> main` on a terminal, `!\trefs/heads/main:refs/…\t
    // [rejected]` in the porcelain output simple-git actually gets).
    "non-fast-forward",
    /non-fast-forward|\[rejected\]|\(fetch first\)|\(stale info\)|Updates were rejected because/i,
  ],
  ["invalid-refspec", /not a full refname|src refspec .+ does not match any|matches more than one/i],
  [
    "network",
    /Could not resolve host|Connection (?:timed out|refused|reset)|The remote end hung up|RPC failed|early EOF|Operation timed out|unable to access '/i,
  ],
];

/** What kind of failure a `git push` error describes. Never throws. */
export function classifyPushFailure(err: unknown): PushFailureClass {
  const msg = err instanceof Error ? err.message : String(err);
  for (const [cls, pattern] of PUSH_FAILURE_PATTERNS) {
    if (pattern.test(msg)) return cls;
  }
  return "unknown";
}

/**
 * Check if a git push error is a non-fast-forward rejection (branch has
 * diverged) — i.e. the one case whose remedy really is a rebase.
 */
export function isNonFastForwardError(err: unknown): boolean {
  return classifyPushFailure(err) === "non-fast-forward";
}

/**
 * Whether a push failure of this class is plausibly an artefact of ShipIt's own
 * in-flight history rewrite, and so worth retrying rather than reporting.
 *
 * Exactly the two shapes a push aimed at a mid-rebase workspace produces: the
 * refspec refusal (detached HEAD — the 2026-08-17 incident) and a genuine
 * non-fast-forward against history the driver is about to force-push. An auth,
 * LFS, or network failure is real whatever else is in flight, and delaying its
 * report across the scheduler's whole deferral budget would hide it.
 */
export function isRewriteWindowPushFailure(err: unknown): boolean {
  const cls = classifyPushFailure(err);
  return cls === "non-fast-forward" || cls === "invalid-refspec";
}
