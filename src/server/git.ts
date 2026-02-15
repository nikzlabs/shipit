import simpleGit, { type SimpleGit, type LogResult } from "simple-git";

const WORKSPACE_DIR = "/workspace";

export interface GitCommitInfo {
  hash: string;
  message: string;
  date: string;
  author: string;
}

export class GitManager {
  private git: SimpleGit;

  constructor() {
    this.git = simpleGit(WORKSPACE_DIR);
  }

  /** Ensure /workspace is a git repo with at least one commit. */
  async init(): Promise<void> {
    const isRepo = await this.git.checkIsRepo();
    if (!isRepo) {
      await this.git.init();
      await this.git.addConfig("user.email", "vibe@local");
      await this.git.addConfig("user.name", "Vibe");
      // Create initial commit so rollback always has a base
      await this.git.add(".");
      await this.git.commit("Initial commit", { "--allow-empty": null });
      console.log("[git] Initialized new repo in", WORKSPACE_DIR);
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
}
