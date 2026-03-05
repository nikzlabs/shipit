import simpleGit, { type SimpleGit } from "simple-git";

/**
 * RepoGit — shared-repo and worktree lifecycle management.
 *
 * Operates on a shared repo directory (one clone per remote URL).
 * Used by the orchestrator to clone, fetch, and manage worktrees
 * across multiple sessions. Contrast with GitManager which operates
 * on a single session workspace.
 */
export class RepoGit {
  private git: SimpleGit;

  constructor(repoDir: string) {
    this.git = simpleGit(repoDir);
  }

  /**
   * Clone a remote repository into this directory.
   * The directory must be empty or non-existent.
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
   * Tries local refs first to avoid network calls and credential prompts,
   * then falls back to querying the remote.
   */
  async getDefaultBranch(remote = "origin"): Promise<string> {
    // Try local symbolic-ref first (set by git clone, no network call)
    try {
      const head = await this.git.raw(["symbolic-ref", `refs/remotes/${remote}/HEAD`]);
      const match = /refs\/remotes\/[^/]+\/(.+)/.exec(head.trim());
      if (match) return match[1];
    } catch {
      // symbolic-ref not set — fall through
    }

    // Fall back to remote query (requires network + credentials)
    const result = await this.git.remote(["show", remote]);
    const match = /HEAD branch:\s*(\S+)/.exec((result ?? ""));
    return match?.[1] ?? "main";
  }

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
  async listWorktrees(): Promise<{ path: string; branch: string; head: string }[]> {
    const output = await this.git.raw(["worktree", "list", "--porcelain"]);
    const worktrees: { path: string; branch: string; head: string }[] = [];
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

  /** Delete a local branch. */
  async deleteBranch(branchName: string): Promise<void> {
    await this.git.branch(["-D", branchName]);
    console.log("[git] Deleted branch:", branchName);
  }

  /**
   * Check if this repo is empty (no commits).
   * Returns true if the repo has no commits yet.
   */
  async isEmpty(): Promise<boolean> {
    try {
      const result = await this.git.log({ maxCount: 1 });
      return result.all.length === 0;
    } catch {
      return true;
    }
  }
}
