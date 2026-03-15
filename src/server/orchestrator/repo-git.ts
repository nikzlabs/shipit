import fs from "node:fs";
import path from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";

/**
 * RepoGit — bare cache management and per-session clone lifecycle.
 *
 * Manages a bare repo cache directory (one per remote URL) and creates
 * independent full clones for each session. No worktrees — each session
 * gets its own complete .git/ directory via hardlinked local clones.
 */
export class RepoGit {
  private git: SimpleGit;
  readonly repoDir: string;

  constructor(repoDir: string) {
    this.repoDir = repoDir;
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

  /**
   * Clone a remote repository as a bare repo into this directory.
   * Used to create the repo cache at /workspace/repo-cache/{hash}.
   */
  async cloneBare(url: string): Promise<void> {
    // Clone bare into the current directory. simple-git operates on repoDir,
    // but `git clone --bare` needs the parent to exist with the target as ".".
    await this.git.raw(["clone", "--bare", url, "."]);
    console.log("[git] Cloned bare repo:", this.repoDir);
  }

  /**
   * Fetch all refs in the bare cache from origin.
   * Skips if the last fetch was less than `ttlMs` ago.
   */
  async fetchCache(ttlMs = 60_000): Promise<void> {
    const markerPath = path.join(this.repoDir, ".shipit-last-fetch");
    try {
      const stat = fs.statSync(markerPath);
      if (Date.now() - stat.mtimeMs < ttlMs) {
        return; // Fresh enough
      }
    } catch {
      // Marker doesn't exist — proceed with fetch
    }
    await this.git.raw(["fetch", "--all", "--force", "--prune"]);
    // Touch the marker file
    fs.writeFileSync(markerPath, String(Date.now()));
    console.log("[git] Fetched bare cache:", this.repoDir);
  }

  /**
   * Clone from the bare cache into a session directory using --local
   * for hardlinked objects (fast, disk-efficient on same filesystem).
   * Configures gc.auto=0 to prevent hardlink breakage.
   */
  async cloneFromCache(sessionDir: string, remoteUrl?: string): Promise<void> {
    // git clone --local creates hardlinks for objects on the same volume
    await simpleGit().raw(["clone", "--local", this.repoDir, sessionDir]);
    // Disable auto-gc in the session clone to prevent hardlink breakage
    const sessionGit = simpleGit(sessionDir);
    await sessionGit.raw(["config", "gc.auto", "0"]);
    // Reset origin to the real remote URL (clone --local sets it to the bare cache path)
    if (remoteUrl) {
      await sessionGit.raw(["remote", "set-url", "origin", remoteUrl]);
    }
    console.log("[git] Cloned from cache:", this.repoDir, "→", sessionDir);
  }

  /** Fetch a single branch from a remote (force-updates the tracking ref). */
  async fetch(remote: string, branch: string): Promise<void> {
    // --force: prevent "unable to update local ref" errors when concurrent
    // fetches race on the same repo (safe for remote tracking refs).
    await this.git.fetch(remote, branch, ["--force"]);
  }

  /**
   * Get the default branch name from a remote (e.g., "main" or "master").
   * Tries local refs first to avoid network calls and credential prompts,
   * then falls back to querying the remote.
   */
  async getDefaultBranch(remote = "origin"): Promise<string> {
    // Non-bare repos: check refs/remotes/origin/HEAD (set by git clone, no network)
    try {
      const head = await this.git.raw(["symbolic-ref", `refs/remotes/${remote}/HEAD`]);
      const match = /refs\/remotes\/[^/]+\/(.+)/.exec(head.trim());
      if (match) return match[1];
    } catch {
      // symbolic-ref not set — fall through
    }

    // Bare repos: HEAD points directly at refs/heads/<branch>
    try {
      const head = await this.git.raw(["symbolic-ref", "HEAD"]);
      const match = /refs\/heads\/(.+)/.exec(head.trim());
      if (match) return match[1];
    } catch {
      // No HEAD — fall through
    }

    return "main";
  }

  /** Delete a remote branch. Used during session cleanup. */
  async deleteBranch(branchName: string): Promise<void> {
    await this.git.raw(["push", "origin", "--delete", branchName]);
    console.log("[git] Deleted remote branch:", branchName);
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

  /**
   * Create an initial empty commit in an empty repo so that
   * clones have a valid HEAD.
   */
  async createInitialCommit(): Promise<void> {
    await this.git.commit("Initial commit", { "--allow-empty": null });
    console.log("[git] Created initial commit in bare cache");
  }
}
