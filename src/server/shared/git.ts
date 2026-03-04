import simpleGit, { type SimpleGit, type LogResult } from "simple-git";

const DEFAULT_WORKSPACE_DIR = "/workspace";

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
   * Stage all changes and commit. Returns the commit hash, or null
   * if there was nothing to commit.
   */
  async autoCommit(summary: string): Promise<string | null> {
    // Check for changes before staging — skip entirely if nothing changed
    const status = await this.git.status();
    if (status.isClean()) {
      return null;
    }

    // Stage everything (new, modified, deleted) and commit
    await this.git.add("-A");
    const message = summary || "Claude turn";
    const result = await this.git.commit(message);
    const hash = result.commit || "";
    console.log("[git] Committed:", hash, message, "on branch:", status.current ?? "(detached)");
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
  async diffNameStatus(fromCommit: string, toCommit: string): Promise<Array<{ status: string; path: string; oldPath?: string }>> {
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

}
