import simpleGit, { type SimpleGit, type LogResult } from "simple-git";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_WORKSPACE_DIR = "/workspace";

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
  content: string; // File content with conflict markers
}

export type RebaseResult =
  | { status: "clean" }
  | { status: "conflicts"; conflicts: RebaseConflictFile[] };

export interface AutoCommitResult {
  /** New commit hash, or null when nothing was committed. */
  commitHash: string | null;
  /**
   * Paths git reports as unmerged (`status.conflicted`). Non-empty during a
   * merge or rebase with unresolved paths. When non-empty, no commit was
   * made — the agent must finish resolving first.
   */
  conflictedFiles: string[];
  /**
   * True when a `.git/rebase-merge` or `.git/rebase-apply` directory exists
   * — i.e. a rebase is mid-flight. When true, no commit was made even if
   * `conflictedFiles` is empty (e.g. all conflicts have been staged but
   * `git rebase --continue` hasn't been called yet). We deliberately rely on
   * git's own state here instead of scanning file contents, so test files
   * and docs that happen to contain marker-shaped text commit normally.
   */
  rebaseInProgress: boolean;
}

export class GitManager {
  private git: SimpleGit;

  /**
   * @param workspaceDir - Git working directory. Defaults to `/workspace`.
   *   Override in tests to use a temp directory.
   */
  constructor(workspaceDir?: string) {
    this.git = simpleGit(workspaceDir ?? DEFAULT_WORKSPACE_DIR);
  }

  /** Get the current HEAD commit hash. Returns null if no commits exist. */
  async getHeadHash(): Promise<string | null> {
    try {
      const hash = await this.git.revparse(["HEAD"]);
      return hash.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Ensure the workspace is a git repo with at least one commit.
   * Identity and commit.gpgsign are inherited from the global git config
   * (set via GIT_CONFIG_GLOBAL).
   */
  async init(): Promise<void> {
    const isRepo = await this.git.checkIsRepo();
    if (!isRepo) {
      await this.git.init(["--initial-branch=main"]);
      // Create initial commit so rollback always has a base
      await this.git.add(".");
      await this.git.commit("Initial commit", { "--allow-empty": null });
      console.log("[git] Initialized repo");
    }
  }

  /**
   * Stage all working-tree changes and commit. Refuses the entire commit if
   * git reports unmerged paths or a rebase is mid-flight — committing in
   * that state would freeze a half-resolved merge/rebase onto the branch
   * (the post-turn auto-push then publishes it). The agent has to finish
   * resolving first; the next turn will commit the whole working tree
   * atomically.
   *
   * We trust git's own conflict state (`status.conflicted` +
   * `isRebaseInProgress`) rather than scanning file contents for marker
   * strings. That avoids false positives on legitimate code that mentions
   * `<<<<<<<` etc. (test fixtures, docs, this very codebase).
   */
  async autoCommit(summary: string): Promise<AutoCommitResult> {
    const status = await this.git.status();
    const rebaseInProgress = await this.isRebaseInProgress();
    const conflictedFiles = [...status.conflicted];

    if (conflictedFiles.length > 0 || rebaseInProgress) {
      console.warn(
        "[git] autoCommit refused — git reports unresolved conflict state:",
        rebaseInProgress ? "rebase in progress;" : "",
        conflictedFiles.length > 0 ? `unmerged paths: ${conflictedFiles.join(", ")}` : "",
      );
      return { commitHash: null, conflictedFiles, rebaseInProgress };
    }

    if (status.isClean()) {
      return { commitHash: null, conflictedFiles: [], rebaseInProgress: false };
    }

    await this.git.add("-A");
    const message = summary || "Claude turn";
    const result = await this.git.commit(message);
    const hash = result.commit || "";
    console.log("[git] Committed:", hash, message, "on branch:", status.current ?? "(detached)");
    return { commitHash: hash, conflictedFiles: [], rebaseInProgress: false };
  }

  /** Return recent commit log entries. */
  async log(maxCount = 50): Promise<GitCommitInfo[]> {
    let result: LogResult;
    try {
      result = await this.git.log({ maxCount });
    } catch {
      // Empty repo with no commits
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

  /** Hard-reset to a specific commit hash. */
  async rollback(commitHash: string): Promise<void> {
    await this.git.reset(["--hard", commitHash]);
    console.log("[git] Rolled back to", commitHash);
  }

  /** Add or update a named remote. */
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

  /** List configured remotes. */
  async getRemotes(): Promise<GitRemote[]> {
    const remotes = await this.git.getRemotes(true);
    return remotes.map((r) => ({
      name: r.name,
      url: r.refs.push || r.refs.fetch || "",
    }));
  }

  /** Get the current branch name. */
  async getCurrentBranch(): Promise<string> {
    const status = await this.git.status();
    return status.current ?? "main";
  }

  /** Create and checkout a new local branch. */
  async checkoutNewBranch(branchName: string): Promise<void> {
    await this.git.checkoutLocalBranch(branchName);
    console.log("[git] Created and checked out branch:", branchName);
  }

  /** Rename a branch. */
  async renameBranch(oldName: string, newName: string): Promise<void> {
    await this.git.branch(["-m", oldName, newName]);
    console.log("[git] Renamed branch:", oldName, "→", newName);
  }

  /** Push to a remote. Returns a summary string. */
  async push(remote = "origin", branch?: string): Promise<string> {
    const currentBranch = branch ?? (await this.getCurrentBranch());
    await this.git.push(remote, currentBranch, ["--set-upstream"]);
    const msg = `Pushed to ${remote}/${currentBranch}`;
    console.log("[git]", msg);
    return msg;
  }

  /** Pull from a remote. Returns a summary string. */
  async pull(remote = "origin", branch?: string): Promise<string> {
    const currentBranch = branch ?? (await this.getCurrentBranch());
    await this.git.pull(remote, currentBranch);
    const msg = `Pulled from ${remote}/${currentBranch}`;
    console.log("[git]", msg);
    return msg;
  }

  /** List remote branches. */
  async listRemoteBranches(remote = "origin"): Promise<string[]> {
    const result = await this.git.branch(["-r"]);
    return result.all
      .filter((b) => b.startsWith(`${remote}/`))
      .map((b) => b.replace(`${remote}/`, ""));
  }

  /**
   * Get total insertions/deletions between the current branch and a base branch.
   * Tries origin/<branch>, then local <branch>, then common fallbacks.
   */
  async diffStatVsBranch(baseBranch: string): Promise<{ insertions: number; deletions: number }> {
    const refs = [
      `origin/${baseBranch}`,
      baseBranch,
      ...(baseBranch !== "master" ? ["origin/master", "master"] : []),
    ];
    for (const ref of refs) {
      try {
        const result = await this.git.diffSummary([`${ref}...HEAD`]);
        return {
          insertions: result.insertions,
          deletions: result.deletions,
        };
      } catch {
        // try next ref
      }
    }
    return { insertions: 0, deletions: 0 };
  }

  /**
   * Get per-file diff summary (files changed with insertions/deletions).
   * Returns an empty array if there are no commits or no changes.
   */
  async diffSummary(range?: string): Promise<{ file: string; insertions: number; deletions: number }[]> {
    try {
      const result = await this.git.diffSummary([range ?? "HEAD~1...HEAD"]);
      return result.files.map((f) => ({
        file: f.file,
        insertions: (f as { insertions: number }).insertions ?? 0,
        deletions: (f as { deletions: number }).deletions ?? 0,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Find the merge-base between two refs.
   * Returns the common ancestor commit hash, or null if none found.
   */
  async mergeBase(ref1: string, ref2: string): Promise<string | null> {
    try {
      const result = await this.git.raw(["merge-base", ref1, ref2]);
      return result.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve a base branch to a valid ref, trying origin/<branch>, then local <branch>,
   * then common fallbacks. Returns null if no valid ref found.
   */
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
        // try next ref
      }
    }
    return null;
  }

  /** Merge a branch into the current branch. Returns the merge commit hash on success. */
  async merge(branchName: string): Promise<{ success: boolean; conflicts?: string[] }> {
    try {
      await this.git.merge([branchName]);
      return { success: true };
    } catch (err: unknown) {
      // Check for merge conflicts
      const status = await this.git.status();
      if (status.conflicted.length > 0) {
        // Abort the merge so the working tree is clean
        await this.git.merge(["--abort"]);
        return { success: false, conflicts: status.conflicted };
      }
      throw err;
    }
  }

  /**
   * Get the contents of a file at a specific commit.
   * Returns empty string if the file doesn't exist at that commit.
   */
  async getFileAtCommit(commitHash: string, filePath: string): Promise<string> {
    try {
      return await this.git.show([`${commitHash}:${filePath}`]);
    } catch {
      return "";
    }
  }

  /**
   * Get list of changed files between two commits with their status.
   * Returns entries like { status: "A", path: "src/foo.ts", oldPath?: "src/bar.ts" }.
   */
  async diffNameStatus(fromCommit: string, toCommit: string): Promise<{ status: string; path: string; oldPath?: string }[]> {
    try {
      const output = await this.git.diff(["--name-status", fromCommit, toCommit]);
      if (!output.trim()) return [];
      return output.trim().split("\n").map((line) => {
        const parts = line.split("\t");
        const status = parts[0].charAt(0); // R100 → R, etc.
        if (status === "R" && parts.length >= 3) {
          return { status, path: parts[2], oldPath: parts[1] };
        }
        return { status, path: parts[1] };
      });
    } catch {
      return [];
    }
  }

  /** Fetch from a remote. */
  async fetch(remote = "origin"): Promise<void> {
    await this.git.fetch(remote);
    console.log("[git] Fetched from", remote);
  }

  /**
   * Check if `ancestor` is an ancestor of `descendant`.
   * Returns true if descendant already contains ancestor (i.e. no rebase needed).
   *
   * Note: We can't use `merge-base --is-ancestor` via simple-git because simple-git's
   * `raw()` doesn't properly handle exit code 1 (not-ancestor) vs exit code 0 (is-ancestor).
   * Instead we compare merge-base output to the ancestor's resolved hash.
   */
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    try {
      const mergeBaseHash = (await this.git.raw(["merge-base", ancestor, descendant])).trim();
      const ancestorHash = (await this.git.revparse([ancestor])).trim();
      return mergeBaseHash === ancestorHash;
    } catch {
      return false;
    }
  }

  /** Rebase current branch onto a target ref. */
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
      // Other rebase failure — abort and rethrow
      try {
        await this.git.rebase(["--abort"]);
      } catch {
        // abort may also fail if rebase wasn't properly started
      }
      throw err;
    }
  }

  /** Continue a rebase after conflicts are resolved. */
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

  /** Abort an in-progress rebase. */
  async rebaseAbort(): Promise<void> {
    await this.git.rebase(["--abort"]);
    console.log("[git] Rebase aborted");
  }

  /** Check if a rebase is in progress. */
  async isRebaseInProgress(): Promise<boolean> {
    try {
      // --absolute-git-dir returns the full path (avoids relative path issues in clones)
      const gitDir = (await this.git.revparse(["--absolute-git-dir"])).trim();
      return (
        fs.existsSync(path.join(gitDir, "rebase-merge")) ||
        fs.existsSync(path.join(gitDir, "rebase-apply"))
      );
    } catch {
      return false;
    }
  }

  /** Force push with lease — safe force push that fails if remote has unexpected commits. */
  async forcePush(remote = "origin", branch?: string): Promise<string> {
    const currentBranch = branch ?? (await this.getCurrentBranch());
    await this.git.push(remote, currentBranch, ["--force-with-lease", "--set-upstream"]);
    const msg = `Force pushed to ${remote}/${currentBranch}`;
    console.log("[git]", msg);
    return msg;
  }

  /** Stage all changes (used after resolving conflicts before rebase --continue). */
  async stageAll(): Promise<void> {
    await this.git.add("-A");
  }

  /**
   * Stage only the given paths and commit them. Returns the commit hash, or
   * null when there's nothing to commit (paths produced no staged changes —
   * e.g. an uninstall that already happened).
   *
   * Unlike `autoCommit()`, this does NOT run `git add -A`. The skill-install
   * flow (docs/149) needs path-scoped staging because the *user*, not the
   * agent, is driving the change and there may be unrelated edits in the
   * working tree. The next user turn's `postTurnCommit()` will still sweep
   * those unrelated edits into a fresh commit — that's auto-commit's job.
   * This method just keeps the install commit itself clean.
   *
   * Paths must be relative to the workspace root and must already exist on
   * disk (for additions) or be staged-as-deleted (for removals — pass the
   * deleted path; `git add` handles both).
   */
  async commitPaths(paths: string[], message: string): Promise<string | null> {
    if (paths.length === 0) return null;
    await this.git.add(paths);
    const status = await this.git.status();
    if (status.isClean()) return null;
    const result = await this.git.commit(message);
    const hash = result.commit || "";
    console.log("[git] Committed (path-scoped):", hash, message);
    return hash;
  }

}
