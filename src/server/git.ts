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
}
