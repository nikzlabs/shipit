import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";

/**
 * Validate a bare cache directory and re-clone it from the remote if it's
 * missing or corrupt. Returns the (possibly-fresh) RepoGit instance.
 *
 * Called by every path that operates on a bare cache (claim-session,
 * unarchive). A cache can go missing for reasons outside the orchestrator's
 * control — manual filesystem wipe, an unmount, an interrupted previous
 * clone — and the database record (status="ready") doesn't notice. Without
 * recovery, the next claim-session falls into a slow-path that immediately
 * blows up with "Cannot use simple-git on a directory that does not exist",
 * leaving the repo unusable until manual re-add. Lazy re-clone restores
 * the cache transparently on first touch.
 *
 * Detection: a healthy bare cache has a `HEAD` file at its top level.
 * Missing dir, empty dir, or a partial download all fail this check.
 *
 * Recovery: rm + mkdir + `cloneBare(repoUrl)`. The repo store record is
 * left alone — the caller already trusts it. Idempotent (concurrent
 * callers will both re-clone, but the slow path is already serialized
 * per-repo by the claim chain in `api-routes-session.ts`).
 */
export async function ensureBareCache(
  cacheDir: string,
  repoUrl: string,
  createRepoGit: (dir: string) => RepoGit,
): Promise<{ git: RepoGit; recovered: boolean }> {
  const headPath = path.join(cacheDir, "HEAD");
  // eslint-disable-next-line no-restricted-syntax -- stat existence-check idiom (matches the rest of this codebase)
  const valid = await fsp.stat(headPath).then((s) => s.isFile(), () => false);
  if (valid) {
    return { git: createRepoGit(cacheDir), recovered: false };
  }
  console.warn(`[repo-git] Bare cache at ${cacheDir} is missing or corrupt — re-cloning from ${repoUrl}`);
  await fsp.rm(cacheDir, { recursive: true, force: true });
  await fsp.mkdir(cacheDir, { recursive: true });
  const git = createRepoGit(cacheDir);
  await git.cloneBare(repoUrl);
  console.log(`[repo-git] Recovered bare cache: ${cacheDir}`);
  return { git, recovered: true };
}

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
   * Update the origin remote URL. Used to refresh embedded credentials
   * before fetching when tokens rotate.
   */
  async setRemoteUrl(url: string, remote = "origin"): Promise<void> {
    await this.git.raw(["remote", "set-url", remote, url]);
  }

  /**
   * Read the bare cache's current HEAD commit, or `"unknown"` if it can't
   * be resolved (empty repo, corrupt ref). Used to verify `fetchCache`
   * actually advanced the cache — a fetch that "succeeds" against a stale
   * embedded token but never moves HEAD is the silent root cause behind
   * warm sessions provisioned from 270-commit-old config.
   */
  async readHead(): Promise<string> {
    try {
      return (await this.git.raw(["rev-parse", "HEAD"])).trim();
    } catch {
      return "unknown";
    }
  }

  /**
   * Milliseconds since this cache's last successful `fetchCache`, or `null`
   * if it has never been fetched (no marker). Reads the `.shipit-last-fetch`
   * marker that `fetchCache` writes. Used by the proactive pre-fetcher to
   * decide whether the bare cache is fresh enough for the claim path to skip
   * its synchronous workspace fetch (docs/145).
   */
  lastFetchAgeMs(): number | null {
    const markerPath = path.join(this.repoDir, ".shipit-last-fetch");
    try {
      return Date.now() - fs.statSync(markerPath).mtimeMs;
    } catch {
      return null; // Never fetched
    }
  }

  /**
   * Fetch all refs in the bare cache from origin.
   * Skips if the last fetch was less than `ttlMs` ago.
   *
   * Logs HEAD before/after so a fetch that completes without advancing the
   * cache (stale embedded token, wrong remote) is visible in journalctl —
   * the old log line only said "Fetched bare cache" and gave no way to
   * tell a real update from a no-op. Throws on fetch failure so callers
   * can surface a stale-cache warning to the user instead of silently
   * serving warm sessions off frozen config.
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
    const headBefore = await this.readHead();
    await this.git.raw(["fetch", "--all", "--force", "--prune"]);
    // Touch the marker file
    fs.writeFileSync(markerPath, String(Date.now()));
    const headAfter = await this.readHead();
    const advanced = headBefore !== headAfter ? "advanced" : "unchanged";
    console.log(
      `[git] Fetched bare cache: ${this.repoDir} HEAD ${headBefore.slice(0, 9)} → ${headAfter.slice(0, 9)} (${advanced})`,
    );
    // Run gc --auto so accumulated loose objects don't grow the bare cache
    // unboundedly. --auto is cheap when thresholds aren't met (no-op);
    // when they are, git repacks behind the scenes. Non-fatal — gc
    // failure must not block the fetch path.
    try {
      await this.git.raw(["gc", "--auto"]);
    } catch (err) {
      console.warn("[git] gc --auto failed (non-fatal):", String(err));
    }
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
    try {
      await this.git.raw(["push", "origin", "--delete", branchName]);
      console.log("[git] Deleted remote branch:", branchName);
    } catch (err) {
      // Branch may never have been pushed (e.g. renamed before first push,
      // or session archived before any code was committed). That's fine.
      if (String(err).includes("remote ref does not exist")) {
        console.log("[git] Remote branch not found (already gone or never pushed):", branchName);
        return;
      }
      throw err;
    }
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
