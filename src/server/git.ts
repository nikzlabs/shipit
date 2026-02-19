import crypto from "node:crypto";
import simpleGit, { type SimpleGit, type LogResult } from "simple-git";

const DEFAULT_WORKSPACE_DIR = "/workspace";

/** Generate a short random alphanumeric prefix for branch names (5 chars). */
export function generateBranchPrefix(): string {
  return crypto.randomBytes(4).toString("base64url").slice(0, 5).toLowerCase();
}

export interface GitCommitInfo {
  hash: string;
  message: string;
  date: string;
  author: string;
}

export interface GitRemote {
  name: string;
  url: string;
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

  /** Ensure the workspace is a git repo with at least one commit. */
  async init(): Promise<void> {
    const isRepo = await this.git.checkIsRepo();
    if (!isRepo) {
      await this.git.init();
      await this.git.addConfig("user.email", "shipit@local");
      await this.git.addConfig("user.name", "ShipIt");
      // Disable commit signing — the workspace repo doesn't need GPG/SSH signatures
      await this.git.addConfig("commit.gpgsign", "false");
      // Create initial commit so rollback always has a base
      await this.git.add(".");
      await this.git.commit("Initial commit", { "--allow-empty": null });
      console.log("[git] Initialized repo");
    }
  }

  /**
   * Stage all changes and commit. Returns the commit hash, or null
   * if there was nothing to commit.
   */
  async autoCommit(summary: string): Promise<string | null> {
    // Stage everything (new, modified, deleted)
    await this.git.add("-A");

    const status = await this.git.status();
    if (status.isClean()) {
      console.log("[git] Nothing to commit");
      return null;
    }

    const message = summary || "Claude turn";
    const result = await this.git.commit(message);
    const hash = result.commit || "";
    console.log("[git] Committed:", hash, message);
    return hash;
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

  /** Parse owner/repo from a GitHub remote URL. */
  static parseGitHubRemote(url: string): { owner: string; repo: string } | null {
    // Handle HTTPS: https://github.com/owner/repo.git
    const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
    if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
    // Handle SSH: git@github.com:owner/repo.git
    const sshMatch = url.match(/github\.com:([^/]+)\/([^/.]+)/);
    if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
    return null;
  }

  /**
   * Clone a remote repository into this workspace directory.
   * The workspace dir must be empty or non-existent.
   */
  async clone(url: string, branch?: string): Promise<void> {
    const args = ["clone", url, "."];
    if (branch) args.push("--branch", branch);
    await this.git.raw(args);
  }

  /** Fetch all branches from a remote. */
  async fetch(remote = "origin"): Promise<void> {
    await this.git.fetch(remote);
  }

  /**
   * Get the default branch name from a remote (e.g., "main" or "master").
   */
  async getDefaultBranch(remote = "origin"): Promise<string> {
    const result = await this.git.remote(["show", remote]);
    const match = (result ?? "").match(/HEAD branch:\s*(\S+)/);
    return match?.[1] ?? "main";
  }

  /**
   * Get total insertions/deletions between the current branch and a base branch.
   * Used for the PR status bar diff stats.
   */
  async diffStatVsBranch(baseBranch: string): Promise<{ insertions: number; deletions: number }> {
    try {
      const result = await this.git.diffSummary([`origin/${baseBranch}...HEAD`]);
      return {
        insertions: result.insertions,
        deletions: result.deletions,
      };
    } catch {
      return { insertions: 0, deletions: 0 };
    }
  }

  /**
   * Get per-file diff summary (files changed with insertions/deletions).
   * Returns an empty array if there are no commits or no changes.
   */
  async diffSummary(): Promise<Array<{ file: string; insertions: number; deletions: number }>> {
    try {
      const result = await this.git.diffSummary(["HEAD~1...HEAD"]);
      return result.files.map((f) => ({
        file: f.file,
        insertions: (f as { insertions: number }).insertions ?? 0,
        deletions: (f as { deletions: number }).deletions ?? 0,
      }));
    } catch {
      return [];
    }
  }

  /** Check whether git has a user.name and user.email configured (any scope). */
  async hasIdentity(): Promise<boolean> {
    try {
      const name = await this.git.getConfig("user.name");
      const email = await this.git.getConfig("user.email");
      return Boolean(name.value?.trim()) && Boolean(email.value?.trim());
    } catch {
      return false;
    }
  }

  /** Set local git identity so commits work. */
  async setIdentity(name: string, email: string): Promise<void> {
    await this.git.addConfig("user.name", name);
    await this.git.addConfig("user.email", email);
    await this.git.addConfig("commit.gpgsign", "false");
    console.log("[git] Set identity:", name, "<" + email + ">");
  }

  // ---- Worktree operations ----

  /** Create a new worktree with a new branch. */
  async createWorktree(
    worktreePath: string,
    branchName: string,
    startPoint?: string,
  ): Promise<void> {
    const args = ["worktree", "add", worktreePath, "-b", branchName];
    if (startPoint) args.push(startPoint);
    await this.git.raw(args);
    console.log("[git] Created worktree:", worktreePath, "branch:", branchName);
  }

  /** Remove a worktree. */
  async removeWorktree(worktreePath: string): Promise<void> {
    await this.git.raw(["worktree", "remove", worktreePath, "--force"]);
    console.log("[git] Removed worktree:", worktreePath);
  }

  /** List all worktrees for this repo. */
  async listWorktrees(): Promise<Array<{ path: string; branch: string; head: string }>> {
    const output = await this.git.raw(["worktree", "list", "--porcelain"]);
    const worktrees: Array<{ path: string; branch: string; head: string }> = [];
    let current: Partial<{ path: string; branch: string; head: string }> = {};

    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current.path) worktrees.push(current as { path: string; branch: string; head: string });
        current = { path: line.replace("worktree ", "") };
      } else if (line.startsWith("HEAD ")) {
        current.head = line.replace("HEAD ", "");
      } else if (line.startsWith("branch ")) {
        current.branch = line.replace("branch refs/heads/", "");
      }
    }
    if (current.path) worktrees.push(current as { path: string; branch: string; head: string });

    return worktrees;
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

  /** Delete a local branch. */
  async deleteBranch(branchName: string): Promise<void> {
    await this.git.branch(["-D", branchName]);
    console.log("[git] Deleted branch:", branchName);
  }
}
