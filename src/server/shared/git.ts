import { type SimpleGit, type LogResult } from "simple-git";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { scanDiffForSecrets, redactSecretsInText, type SecretFinding } from "./secret-scan.js";
import { safeSimpleGit, gitArgsWithHooksDisabled } from "./git-hooks-guard.js";
import {
  type GitRemoteCredential,
  type GitRemoteCredentialResolver,
  credentialledGit,
  resolveTreeRemoteCredential,
  withPreemptiveAuthFallback,
} from "./git-remote-credential.js";
import { gitSpawnOverridesForTree } from "./git-tree-uid.js";
import { pushLfsObjects } from "./git-lfs-push.js";

export interface GitManagerOptions {
  resolveRemoteCredential?: GitRemoteCredentialResolver;
}

const DEFAULT_WORKSPACE_DIR = "/workspace";
const STDERR_TAIL_LIMIT = 8192;

// pnpm can relocate its store to the workspace mountpoint despite store-dir config.
export function ensurePnpmStoreGitExcluded(repoDir: string): void {
  ensureGitExcluded(repoDir, [".pnpm-store/"]);
}

export function ensureGitExcluded(repoDir: string, entries: readonly string[]): boolean {
  const excludePath = path.join(repoDir, ".git", "info", "exclude");
  try {
    let contents = "";
    try {
      contents = fs.readFileSync(excludePath, "utf-8");
    } catch {
      // Create info/exclude if absent.
    }
    const present = new Set(contents.split("\n").map((line) => line.trim()));
    const missing = entries.filter((entry) => !present.has(entry));
    if (missing.length === 0) return true;
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const sep = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(excludePath, `${sep}${missing.join("\n")}\n`);
    return true;
  } catch (err) {
    console.warn(
      `[git] failed to write exclude entries to ${excludePath}:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

// Callers serialize writes. Use exact materialized paths so user files remain visible.
export function ensureGitExcludedBlock(
  repoDir: string,
  blockName: string,
  entries: readonly string[],
): boolean {
  const begin = `# BEGIN ${blockName} (managed by ShipIt — do not edit)`;
  const end = `# END ${blockName}`;
  const excludePath = path.join(repoDir, ".git", "info", "exclude");
  try {
    let contents = "";
    try {
      contents = fs.readFileSync(excludePath, "utf-8");
    } catch {
      // Create info/exclude if absent.
    }
    const lines = contents.split("\n");
    const from = lines.indexOf(begin);
    // An orphan BEGIN must not swallow user rules: remove only that marker.
    const to = from === -1 ? -1 : lines.indexOf(end, from + 1);
    const kept = from === -1
      ? lines
      : [...lines.slice(0, from), ...lines.slice(to === -1 ? from + 1 : to + 1)];
    const block = entries.length > 0 ? [begin, ...entries, end] : [];
    const next = [...trimTrailingBlanks(kept), ...block].join("\n");
    const normalized = next.endsWith("\n") || next === "" ? next : `${next}\n`;
    if (normalized === contents) return true;
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    // Atomic replacement keeps an interrupted write from losing ignore rules.
    const tmp = `${excludePath}.shipit-tmp-${process.pid}`;
    fs.writeFileSync(tmp, normalized);
    fs.renameSync(tmp, excludePath);
    return true;
  } catch (err) {
    console.warn(
      `[git] failed to write the ${blockName} exclude block to ${excludePath}:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

function trimTrailingBlanks(lines: readonly string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out;
}

export interface GitCommitInfo {
  hash: string;
  message: string;
  date: string;
  author: string;
  refs: string[];
}

export interface GitRemote {
  name: string;
  url: string;
}

export interface RebaseConflictFile {
  path: string;
  content: string;
}

export type RebaseResult =
  | { status: "clean" }
  | { status: "conflicts"; conflicts: RebaseConflictFile[] };

export interface AutoCommitResult {
  commitHash: string | null;
  conflictedFiles: string[];
  rebaseInProgress: boolean;
  secretFindings: SecretFinding[];
  /** Callers must report omissions separately from a completely blocked commit. */
  unreadable: UnreadableWorkspace | null;
}

export type UnreadableWorkspace =
  | { kind: "omitted"; detail: string }
  | { kind: "blocked"; detail: string };

// simple-git drops exit codes from errors. git-config.ts pins LC_ALL=C for these.
// Directory omissions exit successfully; their warning is the only failure signal.
const UNREADABLE_DIR_RE = /could not open directory\s+'([^']+)'/;
const UNREADABLE_FILE_RE = /open\("([^"]+)"\): Permission denied/;

export function classifyUnreadableAddFailure(message: string): UnreadableWorkspace | null {
  const blocked = UNREADABLE_FILE_RE.exec(message);
  return blocked ? { kind: "blocked", detail: blocked[1] } : null;
}

export class GitManager {
  private git: SimpleGit;
  private workspaceDir: string;
  // outputHandler captures warnings that simple-git omits from successful results.
  private stderrTail = "";
  private readonly resolveRemoteCredential: GitRemoteCredentialResolver | undefined;

  constructor(workspaceDir?: string, options?: GitManagerOptions) {
    this.resolveRemoteCredential = options?.resolveRemoteCredential;
    this.workspaceDir = workspaceDir ?? DEFAULT_WORKSPACE_DIR;
    this.git = safeSimpleGit(this.workspaceDir).outputHandler(
      (_command, _stdout, stderr) => {
        stderr.on("data", (chunk: Buffer | string) => {
          this.stderrTail = (this.stderrTail + String(chunk)).slice(-STDERR_TAIL_LIMIT);
        });
      },
    );
  }

  private resetStderr(): void {
    this.stderrTail = "";
  }

  get dir(): string {
    return this.workspaceDir;
  }

  private async remoteGit(remote: string): Promise<SimpleGit> {
    const credential = await this.remoteCredential(remote);
    if (!credential) return this.git;
    return credentialledGit(this.workspaceDir, credential);
  }

  private remoteCredential(remote: string): Promise<GitRemoteCredential | null> {
    return resolveTreeRemoteCredential(
      this.workspaceDir,
      remote,
      this.resolveRemoteCredential,
      async () => {
        const remotes = await this.git.getRemotes(true);
        const match = remotes.find((r) => r.name === remote);
        return match?.refs.push || match?.refs.fetch || undefined;
      },
    );
  }

  // A stale credential must not break public reads that worked anonymously.
  // Pushes use remoteGit: an anonymous receive-pack retry cannot succeed.
  private async withRemoteRead<T>(
    remote: string,
    what: string,
    run: (git: SimpleGit) => Promise<T>,
  ): Promise<T> {
    const credential = await this.remoteCredential(remote);
    return withPreemptiveAuthFallback(credential, what, (cred) => run(
      cred ? credentialledGit(this.workspaceDir, cred) : this.git,
    ));
  }

  async getHeadHash(): Promise<string | null> {
    try {
      const hash = await this.git.revparse(["HEAD"]);
      return hash.trim() || null;
    } catch {
      return null;
    }
  }

  async getRefHash(ref: string): Promise<string | null> {
    try {
      const hash = await this.git.revparse(["--verify", ref]);
      return hash.trim() || null;
    } catch {
      return null;
    }
  }

  async init(): Promise<void> {
    const isRepo = await this.git.checkIsRepo();
    if (!isRepo) {
      await this.git.init(["--initial-branch=main"]);
      // Give rollback a base even in an empty workspace.
      await this.git.add(".");
      await this.git.commit("Initial commit", { "--allow-empty": null });
      console.log("[git] Initialized repo");
    }
  }

  async autoCommit(summary: string): Promise<AutoCommitResult> {
    ensurePnpmStoreGitExcluded(this.workspaceDir);
    this.resetStderr();
    const status = await this.git.status();
    // Detect before the clean-tree return: inaccessible changes can look clean.
    const omittedMatch = UNREADABLE_DIR_RE.exec(this.stderrTail);
    const omitted: UnreadableWorkspace | null = omittedMatch
      ? { kind: "omitted", detail: omittedMatch[1] }
      : null;
    if (omitted) {
      console.warn(
        `[git] autoCommit could not read ${omitted.detail} — its contents are `
        + "omitted from this commit. The commit itself still lands.",
      );
    }
    // Trust git's conflict state, not marker-shaped text in source or fixtures.
    const rebaseInProgress = await this.isRebaseInProgress();
    const conflictedFiles = [...status.conflicted];

    if (conflictedFiles.length > 0 || rebaseInProgress) {
      console.warn(
        "[git] autoCommit refused — git reports unresolved conflict state:",
        rebaseInProgress ? "rebase in progress;" : "",
        conflictedFiles.length > 0 ? `unmerged paths: ${conflictedFiles.join(", ")}` : "",
      );
      return { commitHash: null, conflictedFiles, rebaseInProgress, secretFindings: [], unreadable: omitted };
    }

    if (status.isClean()) {
      return { commitHash: null, conflictedFiles: [], rebaseInProgress: false, secretFindings: [], unreadable: omitted };
    }

    try {
      await this.git.add("-A");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const blocked = classifyUnreadableAddFailure(message);
      // Do not label I/O errors or deleted files as permission failures.
      if (!blocked) throw err;
      console.error(
        `[git] autoCommit staged NOTHING — cannot read ${blocked.detail}. `
        + "The whole turn is uncommitted and still in the working tree.",
      );
      return {
        commitHash: null,
        conflictedFiles: [],
        rebaseInProgress: false,
        secretFindings: [],
        unreadable: blocked,
      };
    }

    // Staging can expose a path that status did not see.
    const stagedOmitted = UNREADABLE_DIR_RE.exec(this.stderrTail);
    const unreadable: UnreadableWorkspace | null = omitted
      ?? (stagedOmitted ? { kind: "omitted", detail: stagedOmitted[1] } : null);

    const secretFindings = scanDiffForSecrets(await this.stagedDiff());
    if (secretFindings.length > 0) {
      console.warn(
        "[git] autoCommit refused — likely secret(s) in staged diff:",
        secretFindings.map((f) => `${f.rule} in ${f.file}`).join(", "),
      );
      // Unstage while preserving the work for correction.
      try {
        await this.git.reset(["--mixed"]);
      } catch {
        // An unborn HEAD has nothing to reset to.
      }
      return { commitHash: null, conflictedFiles: [], rebaseInProgress: false, secretFindings, unreadable };
    }

    const message = redactSecretsInText(summary || "Claude turn");
    const result = await this.git.commit(message);
    const hash = result.commit || "";
    console.log("[git] Committed:", hash, message, "on branch:", status.current ?? "(detached)");
    return { commitHash: hash, conflictedFiles: [], rebaseInProgress: false, secretFindings: [], unreadable };
  }

  async stagedDiff(): Promise<string> {
    try {
      return await this.git.diff(["--cached"]);
    } catch {
      return "";
    }
  }

  // New-commit scanners must establish that from is an ancestor of to.
  async diffRange(from: string, to: string): Promise<string> {
    try {
      return await this.git.diff([`${from}..${to}`]);
    } catch {
      return "";
    }
  }

  async log(maxCount = 50): Promise<GitCommitInfo[]> {
    let result: LogResult;
    try {
      result = await this.git.log({ maxCount });
    } catch {
      return [];
    }

    return result.all.map((entry) => ({
      hash: entry.hash,
      message: entry.message,
      date: entry.date,
      author: entry.author_name,
      refs: entry.refs ? entry.refs.split(", ").map((r) => r.trim()).filter(Boolean) : [],
    }));
  }

  async rollback(commitHash: string): Promise<void> {
    await this.git.reset(["--hard", commitHash]);
    console.log("[git] Rolled back to", commitHash);
  }

  async addRemote(name: string, url: string): Promise<void> {
    const remotes = await this.git.getRemotes(true);
    const existing = remotes.find((r) => r.name === name);
    if (existing) {
      await this.git.remote(["set-url", name, url]);
      console.log("[git] Updated remote", name, "→", url);
    } else {
      await this.git.addRemote(name, url);
      console.log("[git] Added remote", name, "→", url);
    }
  }

  async getRemotes(): Promise<GitRemote[]> {
    const remotes = await this.git.getRemotes(true);
    return remotes.map((r) => ({
      name: r.name,
      url: r.refs.push || r.refs.fetch || "",
    }));
  }

  async getCurrentBranch(): Promise<string> {
    const status = await this.git.status();
    return status.current ?? "main";
  }

  async checkoutNewBranch(branchName: string): Promise<void> {
    await this.git.checkoutLocalBranch(branchName);
    console.log("[git] Created and checked out branch:", branchName);
  }

  async renameBranch(oldName: string, newName: string): Promise<void> {
    await this.git.branch(["-m", oldName, newName]);
    console.log("[git] Renamed branch:", oldName, "→", newName);
  }

  // Hooks are disabled, so upload LFS objects explicitly before publishing refs.
  private async uploadLfsObjects(git: SimpleGit, remote: string, branch: string): Promise<void> {
    const outcome = await pushLfsObjects(git, remote, branch);
    if (outcome.status === "pushed") {
      console.log(`[git] Uploaded Git LFS objects for ${remote}/${branch}`);
    } else if (outcome.status === "failed") {
      console.warn(
        `[git] git lfs push ${remote} ${branch} failed — the ref push may be rejected `
        + `with GH008 (unknown Git LFS object): ${outcome.detail}`,
      );
    }
  }

  async push(remote = "origin", branch?: string): Promise<string> {
    const currentBranch = branch ?? (await this.getCurrentBranch());
    const git = await this.remoteGit(remote);
    await this.uploadLfsObjects(git, remote, currentBranch);
    await git.push(remote, currentBranch, ["--set-upstream"]);
    const msg = `Pushed to ${remote}/${currentBranch}`;
    console.log("[git]", msg);
    return msg;
  }

  async pull(remote = "origin", branch?: string): Promise<string> {
    const currentBranch = branch ?? (await this.getCurrentBranch());
    await this.withRemoteRead(remote, "pull", (git) => git.pull(remote, currentBranch));
    const msg = `Pulled from ${remote}/${currentBranch}`;
    console.log("[git]", msg);
    return msg;
  }

  async listRemoteBranches(remote = "origin"): Promise<string[]> {
    const result = await this.git.branch(["-r"]);
    return result.all
      .filter((b) => b.startsWith(`${remote}/`))
      .map((b) => b.replace(`${remote}/`, ""));
  }

  // --stat scales its histogram; only --numstat gives exact per-file counts.
  private async numstatSummary(range: string): Promise<{
    insertions: number;
    deletions: number;
    files: { file: string; insertions: number; deletions: number; binary: boolean }[];
  }> {
    const result = await this.git.diffSummary(["--numstat", range]);
    return {
      insertions: result.insertions,
      deletions: result.deletions,
      files: result.files.map((f) => ({
        file: f.file,
        insertions: (f as { insertions?: number }).insertions ?? 0,
        deletions: (f as { deletions?: number }).deletions ?? 0,
        binary: (f as { binary?: boolean }).binary === true,
      })),
    };
  }

  async diffStatVsBranch(baseBranch: string): Promise<{ insertions: number; deletions: number }> {
    const refs = [
      `origin/${baseBranch}`,
      baseBranch,
      ...(baseBranch !== "master" ? ["origin/master", "master"] : []),
    ];
    for (const ref of refs) {
      try {
        const result = await this.numstatSummary(`${ref}...HEAD`);
        return {
          insertions: result.insertions,
          deletions: result.deletions,
        };
      } catch {
        // Try the next ref.
      }
    }
    return { insertions: 0, deletions: 0 };
  }

  // Compare trees, avoiding the old merge base retained after a squash merge.
  async diffStatTwoDot(ref: string): Promise<{ insertions: number; deletions: number; files: number }> {
    try {
      const result = await this.numstatSummary(`${ref}..HEAD`);
      return { insertions: result.insertions, deletions: result.deletions, files: result.files.length };
    } catch {
      return { insertions: 0, deletions: 0, files: 0 };
    }
  }

  async advancedBeyondMergedBase(baseBranch: string): Promise<boolean> {
    return (await this.mergedBaseProgress(baseBranch)) === "progressed";
  }

  // Callers must freshen origin/<base> first, including narrowed refspecs.
  // A stale fork-point ref can report already-shipped work as new.
  async mergedBaseProgress(
    baseBranch: string,
  ): Promise<"progressed" | "base-not-contained" | "no-new-work" | "base-unknown"> {
    const baseRef = `origin/${baseBranch}`;
    let baseTip: string;
    try {
      baseTip = (await this.git.revparse(["--verify", baseRef])).trim();
    } catch {
      return "base-unknown";
    }
    if (!baseTip) return "base-unknown";

    const mb = await this.mergeBase(baseRef, "HEAD");
    if (!mb || mb !== baseTip) return "base-not-contained";

    const { files } = await this.diffStatTwoDot(baseRef);
    return files > 0 ? "progressed" : "no-new-work";
  }

  // Caller must fetch: this compares local remote-tracking refs only.
  async headIsAtBase(baseBranch: string): Promise<boolean> {
    const baseRef = `origin/${baseBranch}`;
    try {
      const baseTip = (await this.git.revparse(["--verify", baseRef])).trim();
      if (!baseTip) return false;
      const head = (await this.git.revparse(["--verify", "HEAD"])).trim();
      return head !== "" && head === baseTip;
    } catch {
      return false;
    }
  }

  async currentBranchOrNull(): Promise<string | null> {
    try {
      const ref = (await this.git.revparse(["--abbrev-ref", "HEAD"])).trim();
      return ref && ref !== "HEAD" ? ref : null;
    } catch {
      return null;
    }
  }

  async isMergeOrSequencerInProgress(): Promise<boolean> {
    try {
      const gitDir = (await this.git.revparse(["--absolute-git-dir"])).trim();
      return (
        fs.existsSync(path.join(gitDir, "MERGE_HEAD")) ||
        fs.existsSync(path.join(gitDir, "CHERRY_PICK_HEAD")) ||
        fs.existsSync(path.join(gitDir, "REVERT_HEAD"))
      );
    } catch {
      return false;
    }
  }

  // Caller owns the clean-tree, expected-HEAD, and sequencer safety checks.
  async resetHardToRemoteBase(baseBranch: string): Promise<{ from: string; to: string }> {
    const baseRef = `origin/${baseBranch}`;
    const from = (await this.git.revparse(["HEAD"])).trim();
    const to = (await this.git.revparse(["--verify", baseRef])).trim();
    if (!to) throw new Error(`Cannot resolve ${baseRef}`);
    await this.git.reset(["--hard", baseRef]);
    console.log(`[git] Reset --hard to ${baseRef} (${from.slice(0, 8)} → ${to.slice(0, 8)})`);
    return { from, to };
  }

  async diffSummary(range?: string): Promise<{ file: string; insertions: number; deletions: number; binary: boolean }[]> {
    try {
      const result = await this.numstatSummary(range ?? "HEAD~1...HEAD");
      return result.files;
    } catch {
      return [];
    }
  }

  async mergeBase(ref1: string, ref2: string): Promise<string | null> {
    try {
      const result = await this.git.raw(["merge-base", ref1, ref2]);
      return result.trim() || null;
    } catch {
      return null;
    }
  }

  async getDefaultBranch(): Promise<string> {
    try {
      const head = await this.git.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]);
      const match = /refs\/remotes\/[^/]+\/(.+)/.exec(head.trim());
      if (match) return match[1];
    } catch {
      // Older clones may lack origin/HEAD; probe known branches.
    }
    for (const candidate of ["main", "master"]) {
      try {
        await this.git.revparse(["--verify", `origin/${candidate}`]);
        return candidate;
      } catch {
        // Try the next candidate.
      }
    }
    return "main";
  }

  async resolveBaseBranchRef(baseBranch: string): Promise<string | null> {
    const refs = [
      `origin/${baseBranch}`,
      baseBranch,
      ...(baseBranch !== "master" ? ["origin/master", "master"] : []),
    ];
    for (const ref of refs) {
      try {
        await this.git.revparse(["--verify", ref]);
        return ref;
      } catch {
        // Try the next ref.
      }
    }
    return null;
  }

  async merge(branchName: string): Promise<{ success: boolean; conflicts?: string[] }> {
    try {
      await this.git.merge([branchName]);
      return { success: true };
    } catch (err: unknown) {
      const status = await this.git.status();
      if (status.conflicted.length > 0) {
        await this.git.merge(["--abort"]);
        return { success: false, conflicts: status.conflicted };
      }
      throw err;
    }
  }

  // Release --from takes the incoming tree wholesale but retains HEAD as first
  // parent, so the release remains a descendant of its maintenance branch.
  async mergeOverride(ref: string): Promise<void> {
    const headSha = (await this.git.revparse(["HEAD"])).trim();
    const refSha = (await this.git.revparse([ref])).trim();
    const refTree = (await this.git.revparse([`${ref}^{tree}`])).trim();
    const newCommit = (
      await this.git.raw(["commit-tree", refTree, "-p", headSha, "-p", refSha, "-m", `Merge ${ref} (release override)`])
    ).trim();
    await this.git.reset(["--hard", newCommit]);
    console.log("[git] merge-override (took incoming tree):", ref, "→", newCommit);
  }

  async getFileAtCommit(commitHash: string, filePath: string): Promise<string> {
    try {
      return await this.git.show([`${commitHash}:${filePath}`]);
    } catch {
      return "";
    }
  }

  // simple-git decodes stdout as text; execFile preserves binary blobs.
  async getFileBufferAtCommit(
    commitHash: string,
    filePath: string,
    maxBytes = 16 * 1_048_576,
  ): Promise<Buffer | null> {
    return new Promise((resolve) => {
      execFile(
        "git",
        gitArgsWithHooksDisabled(["show", `${commitHash}:${filePath}`]),
        {
          cwd: this.workspaceDir,
          encoding: "buffer",
          maxBuffer: maxBytes,
          ...gitSpawnOverridesForTree(this.workspaceDir),
        },
        (err, stdout) => {
          if (err || !stdout || stdout.length === 0) resolve(null);
          else resolve(stdout);
        },
      );
    });
  }

  async diffNameStatus(fromCommit: string, toCommit: string): Promise<{ status: string; path: string; oldPath?: string }[]> {
    try {
      const output = await this.git.diff(["--name-status", fromCommit, toCommit]);
      if (!output.trim()) return [];
      return output.trim().split("\n").map((line) => {
        const parts = line.split("\t");
        const status = parts[0].charAt(0);
        if (status === "R" && parts.length >= 3) {
          return { status, path: parts[2], oldPath: parts[1] };
        }
        return { status, path: parts[1] };
      });
    } catch {
      return [];
    }
  }

  async fetch(remote = "origin"): Promise<void> {
    await this.withRemoteRead(remote, "fetch", (git) => git.fetch(remote));
    console.log("[git] Fetched from", remote);
  }

  // Explicit forced refspec updates even narrowed clones and rewritten remote branches.
  async fetchBranch(remote: string, branch: string): Promise<void> {
    await this.withRemoteRead(remote, "fetchBranch", (git) => git.fetch(
      remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
    ));
  }

  async aheadBehind(ref: string): Promise<{ ahead: number; behind: number } | null> {
    try {
      const out = await this.git.raw(["rev-list", "--left-right", "--count", `${ref}...HEAD`]);
      const [behind, ahead] = out.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
      if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
      return { ahead, behind };
    } catch {
      return null;
    }
  }

  // Compare hashes because simple-git does not expose --is-ancestor's exit-code distinction.
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    try {
      const mergeBaseHash = (await this.git.raw(["merge-base", ancestor, descendant])).trim();
      const ancestorHash = (await this.git.revparse([ancestor])).trim();
      return mergeBaseHash === ancestorHash;
    } catch {
      return false;
    }
  }

  async rebase(onto: string): Promise<RebaseResult> {
    try {
      await this.git.rebase([onto]);
      console.log("[git] Rebased onto", onto);
      return { status: "clean" };
    } catch (err: unknown) {
      const status = await this.git.status();
      if (status.conflicted.length > 0) {
        const dir = await this.git.revparse(["--show-toplevel"]);
        const conflicts = status.conflicted.map((file) => ({
          path: file,
          content: fs.readFileSync(path.join(dir.trim(), file), "utf-8"),
        }));
        return { status: "conflicts", conflicts };
      }
      try {
        await this.git.rebase(["--abort"]);
      } catch {
        // The rebase may not have started.
      }
      throw err;
    }
  }

  async rebaseContinue(): Promise<RebaseResult> {
    try {
      await this.git.rebase(["--continue"]);
      console.log("[git] Rebase continued successfully");
      return { status: "clean" };
    } catch (err: unknown) {
      const status = await this.git.status();
      if (status.conflicted.length > 0) {
        const dir = await this.git.revparse(["--show-toplevel"]);
        const conflicts = status.conflicted.map((file) => ({
          path: file,
          content: fs.readFileSync(path.join(dir.trim(), file), "utf-8"),
        }));
        return { status: "conflicts", conflicts };
      }
      throw err;
    }
  }

  async rebaseAbort(): Promise<void> {
    await this.git.rebase(["--abort"]);
    console.log("[git] Rebase aborted");
  }

  async isClean(): Promise<boolean> {
    const status = await this.git.status();
    return status.isClean();
  }

  // Use before destructive cleanup: isClean() alone can hide unreadable changes.
  async inspectWorkingTree(): Promise<{ clean: boolean; unreadable: UnreadableWorkspace | null }> {
    this.resetStderr();
    const status = await this.git.status();
    const match = UNREADABLE_DIR_RE.exec(this.stderrTail);
    return {
      clean: status.isClean(),
      unreadable: match ? { kind: "omitted", detail: match[1] } : null,
    };
  }

  async uncommittedPaths(): Promise<string[]> {
    const status = await this.git.status();
    const paths = new Set<string>();
    for (const f of status.files) paths.add(f.path);
    for (const r of status.renamed) {
      paths.add(r.from);
      paths.add(r.to);
    }
    return [...paths];
  }

  async isRebaseInProgress(): Promise<boolean> {
    try {
      const gitDir = (await this.git.revparse(["--absolute-git-dir"])).trim();
      return (
        fs.existsSync(path.join(gitDir, "rebase-merge")) ||
        fs.existsSync(path.join(gitDir, "rebase-apply"))
      );
    } catch {
      return false;
    }
  }

  async remoteBranchSha(remote = "origin", branch?: string): Promise<string | null> {
    const currentBranch = branch ?? (await this.getCurrentBranch());
    try {
      const out = await this.withRemoteRead(
        remote, "remoteBranchSha", (git) => git.listRemote(["--heads", remote, currentBranch]),
      );
      const line = out
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      if (!line) return null;
      const sha = line.split(/\s+/)[0];
      return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
    } catch {
      return null;
    }
  }

  // Lease against the live tip: local tracking refs can outlive deleted branches.
  async forcePush(remote = "origin", branch?: string): Promise<string> {
    const currentBranch = branch ?? (await this.getCurrentBranch());
    const expected = await this.remoteBranchSha(remote, currentBranch);
    return this.forcePushWithLease(remote, currentBranch, expected);
  }

  // Null expects an absent remote branch and uses a plain push, without a lease.
  async forcePushWithLease(
    remote: string,
    branch: string,
    expectedRemoteSha: string | null,
  ): Promise<string> {
    const args = expectedRemoteSha
      ? [`--force-with-lease=${branch}:${expectedRemoteSha}`, "--set-upstream"]
      : ["--set-upstream"];
    const git = await this.remoteGit(remote);
    await this.uploadLfsObjects(git, remote, branch);
    await git.push(remote, branch, args);
    const msg = `Force pushed to ${remote}/${branch}`;
    console.log("[git]", msg);
    return msg;
  }

  async stageAll(): Promise<void> {
    await this.git.add("-A");
  }

  async createBranchFrom(branch: string, startPoint: string): Promise<void> {
    await this.git.checkout(["-B", branch, startPoint]);
    console.log("[git] checkout -B", branch, "from", startPoint);
  }

  // branch -f refuses the checked-out branch; callers must skip that case.
  async forceUpdateBranchRef(branch: string, target: string): Promise<void> {
    await this.git.raw(["branch", "-f", branch, target]);
    console.log("[git] branch -f", branch, "→", target);
  }

  async resetBranchTo(branch: string, startPoint: string): Promise<void> {
    await this.createBranchFrom(branch, startPoint);
  }

  async cherryPick(shas: string[]): Promise<{ success: boolean; conflictedSha?: string; conflicts?: string[] }> {
    if (shas.length === 0) return { success: true };
    try {
      await this.git.raw(["cherry-pick", ...shas]);
      console.log("[git] cherry-picked", shas.join(" "));
      return { success: true };
    } catch (err: unknown) {
      const status = await this.git.status();
      let conflictedSha: string | undefined;
      try {
        conflictedSha = (await this.git.revparse(["CHERRY_PICK_HEAD"])).trim() || undefined;
      } catch {
        conflictedSha = undefined;
      }
      try {
        await this.git.raw(["cherry-pick", "--abort"]);
      } catch {
        // The pick may not have started.
      }
      if (status.conflicted.length > 0 || conflictedSha) {
        return {
          success: false,
          ...(conflictedSha ? { conflictedSha } : {}),
          conflicts: status.conflicted,
        };
      }
      throw err;
    }
  }

  async listTags(pattern?: string): Promise<string[]> {
    try {
      const args = ["tag", "--list", ...(pattern ? [pattern] : [])];
      const out = await this.git.raw(args);
      return out.split("\n").map((t) => t.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  async tipCommitMessage(ref: string): Promise<string | null> {
    try {
      const out = await this.git.raw(["log", "-1", "--format=%B", ref]);
      return out;
    } catch {
      return null;
    }
  }

  async countCommitsAhead(base: string, head: string): Promise<number> {
    try {
      const out = await this.git.raw(["rev-list", "--count", `${base}..${head}`]);
      const n = Number.parseInt(out.trim(), 10);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }

  async commitSubjects(range: string, maxCount = 10): Promise<{ sha: string; subject: string }[]> {
    try {
      const out = await this.git.raw([
        "log", `--max-count=${maxCount}`, "--format=%h %s", range,
      ]);
      return out
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const sep = line.indexOf(" ");
          return sep === -1
            ? { sha: line, subject: "" }
            : { sha: line.slice(0, sep), subject: line.slice(sep + 1) };
        });
    } catch {
      return [];
    }
  }

  async showFileAtRef(ref: string, filePath: string): Promise<string | null> {
    try {
      return await this.git.raw(["show", `${ref}:${filePath}`]);
    } catch {
      return null;
    }
  }

  async createAndPushTag(tag: string, message: string, remote = "origin", ref?: string): Promise<void> {
    const args = ["tag", "-a", tag, "-m", message, ...(ref ? [ref] : [])];
    await this.git.raw(args);
    await (await this.remoteGit(remote)).push(remote, tag);
    console.log("[git] created + pushed tag", tag);
  }

  async commitPaths(paths: string[], message: string): Promise<string | null> {
    if (paths.length === 0) return null;
    await this.git.add(paths);
    const status = await this.git.status();
    if (status.isClean()) return null;
    const secretFindings = scanDiffForSecrets(await this.stagedDiff());
    if (secretFindings.length > 0) {
      console.warn(
        "[git] commitPaths refused — likely secret(s) in staged diff:",
        secretFindings.map((f) => `${f.rule} in ${f.file}`).join(", "),
      );
      try {
        await this.git.reset(["--mixed"]);
      } catch {
        // An unborn HEAD has nothing to reset to.
      }
      return null;
    }
    const safeMessage = redactSecretsInText(message);
    const result = await this.git.commit(safeMessage);
    const hash = result.commit || "";
    console.log("[git] Committed (path-scoped):", hash, safeMessage);
    return hash;
  }

}
