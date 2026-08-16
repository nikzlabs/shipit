import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { type SimpleGit } from "simple-git";
import { safeSimpleGit, gitArgsWithHooksDisabled } from "../shared/git-hooks-guard.js";
import { gitSpawnOverridesForTree } from "../shared/git-tree-uid.js";
import {
  type GitRemoteCredential,
  gitCredentialConfig,
  gitCredentialEnv,
  sanitizeGitEnv,
} from "../shared/git-remote-credential.js";
import { ensurePnpmStoreGitExcluded } from "../shared/git.js";
import { hasUrlCredentials, stripRemoteUrlCredentials } from "./git-utils.js";
import { handWorkspaceBackToWorker } from "./session-worker-uid.js";
import { linkLfsObjectsIntoClone } from "./git-lfs-store.js";

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
  createRepoGit: (dir: string, credential?: GitRemoteCredential) => RepoGit,
  credential?: GitRemoteCredential,
): Promise<{ git: RepoGit; recovered: boolean }> {
  const headPath = path.join(cacheDir, "HEAD");
  // eslint-disable-next-line no-restricted-syntax -- stat existence-check idiom (matches the rest of this codebase)
  const valid = await fsp.stat(headPath).then((s) => s.isFile(), () => false);
  if (valid) {
    return { git: createRepoGit(cacheDir, credential), recovered: false };
  }
  console.warn(`[repo-git] Bare cache at ${cacheDir} is missing or corrupt — re-cloning from ${repoUrl}`);
  await fsp.rm(cacheDir, { recursive: true, force: true });
  await fsp.mkdir(cacheDir, { recursive: true });
  const git = createRepoGit(cacheDir, credential);
  await git.cloneBare(repoUrl);
  console.log(`[repo-git] Recovered bare cache: ${cacheDir}`);
  return { git, recovered: true };
}

/**
 * The URL to hand git, with any embedded credential removed (docs/262 req 19).
 *
 * Every RepoGit path that records a remote goes through this, not just the one
 * that seemed reachable: `clone`/`cloneBare` because the URL git clones from is
 * the URL it writes to `remote.origin.url`, and `setRemoteUrl`/`cloneFromCache`
 * because they write that key directly — `cloneFromCache` into the session
 * clone that becomes `/project`, whose `.git/config` the agent and every plugin
 * CLI and plugin service can read. Credentials reach git through the per-remote
 * helper (`gitCredentialConfig`) or the global helper, both of which supply the
 * token for the life of the operation and write it nowhere.
 *
 * The warning is the legible half (req 13): a remote that ONLY authenticates
 * through its URL now fails, and this line says why instead of leaving an
 * unexplained authentication error. The URL is logged already-stripped, so the
 * log itself never carries the secret.
 */
function credentialFreeRemote(url: string, context: string): string {
  if (!hasUrlCredentials(url)) return url;
  const clean = stripRemoteUrlCredentials(url);
  console.warn(
    `[git] ${context}: dropped a credential embedded in the remote URL for ${clean} — `
    + "ShipIt never records one in a git config. If this remote authenticates only through "
    + "that URL, the operation will fail to authenticate.",
  );
  return clean;
}

/**
 * docs/266 E3 (planning#404) — the per-remote credential mechanism moved to
 * `shared/git-remote-credential.ts` so `shared/git.ts` can use the identical
 * shape for the dropped-uid git on a session workspace. Re-exported here
 * because this module was its original home (docs/262 req 10) and every
 * existing importer names it; behaviour is unchanged.
 */
export {
  type GitRemoteCredential,
  type GitRemoteCredentialResolver,
  type RemoteOrigin,
  sanitizeGitEnv,
  gitCredentialConfig,
  gitCredentialEnv,
  parseRemoteOrigin,
} from "../shared/git-remote-credential.js";

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

  constructor(repoDir: string, credential?: GitRemoteCredential) {
    this.repoDir = repoDir;
    this.git = credential
      ? safeSimpleGit(repoDir, {
        config: gitCredentialConfig(credential),
        // The three simple-git guards this path opts out of, none of them
        // user-supplied: our own credential helper (host validated, token in
        // the environment), and the `GIT_CONFIG_GLOBAL` / `GIT_EDITOR` this
        // orchestrator sets on purpose — the same false positive
        // `git-utils.ts` documents. Everything else it guards is dropped from
        // the environment instead (see `sanitizeGitEnv`).
        unsafe: {
          allowUnsafeConfigPaths: true,
          allowUnsafeEditor: true,
          allowUnsafeCredentialHelper: true,
        },
      }).env({
        ...sanitizeGitEnv(process.env),
        ...gitCredentialEnv(credential),
        // Fail instead of blocking on a prompt when nothing is supplied or the
        // credential is refused.
        GIT_TERMINAL_PROMPT: "0",
      })
      : safeSimpleGit(repoDir);
  }

  /**
   * Clone a remote repository into this directory.
   * The directory must be empty or non-existent.
   */
  async clone(url: string, branch?: string): Promise<void> {
    const args = ["clone", credentialFreeRemote(url, "clone"), "."];
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
    await this.git.raw(["clone", "--bare", credentialFreeRemote(url, "cloneBare"), "."]);
    await this.ensureFetchRefspec();
    console.log("[git] Cloned bare repo:", this.repoDir);
  }

  /**
   * Configure `remote.origin.fetch` so `git fetch` actually advances the
   * bare cache's local `refs/heads/*`.
   *
   * `git clone --bare` configures NO fetch refspec at all. Without one,
   * `git fetch --all` only writes `FETCH_HEAD` and never updates
   * `refs/heads/main` — so the cache's `HEAD` (a symbolic ref to its default
   * branch) stays frozen at the commit it was first cloned at, forever. Every
   * `--local` clone cut from the cache then branches from that frozen snapshot,
   * which is the root cause behind sessions provisioned from months-old config
   * (docs/157) and the false premise the docs/145 `isWorkspaceCloneInSyncWithCache`
   * gate rests on (it assumes cache HEAD tracks "latest main"). The `+` forces
   * non-fast-forward updates so a force-pushed `main` still syncs.
   *
   * Idempotent: re-running `git config` to the same value is a no-op, so this
   * is safe to call before every fetch — which also self-heals the already-
   * frozen bare caches created before this fix, with no re-clone needed.
   */
  private async ensureFetchRefspec(): Promise<void> {
    await this.git.raw([
      "config",
      "remote.origin.fetch",
      "+refs/heads/*:refs/heads/*",
    ]);
  }

  /**
   * Update a remote's URL — the normalization every caller uses to put a
   * cache's origin back into its plain, credential-free form. The URL is
   * stripped here too (see `credentialFreeRemote`), so this can only ever
   * REMOVE a credential from a config, never install one.
   */
  async setRemoteUrl(url: string, remote = "origin"): Promise<void> {
    await this.git.raw(["remote", "set-url", remote, credentialFreeRemote(url, "setRemoteUrl")]);
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
    // Self-heal caches cloned before the refspec fix: without it `fetch`
    // never advances local heads and the cache HEAD stays frozen (see
    // ensureFetchRefspec). Idempotent, so cheap to run every fetch.
    await this.ensureFetchRefspec();
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
    await safeSimpleGit().raw(["clone", "--local", this.repoDir, sessionDir]);
    // docs/232 — `clone --local` hardlinks `.git/objects` but does NOT carry
    // `.git/lfs`, so an LFS repo's clone starts with an empty content store and
    // re-downloads every asset. Extend the same hardlink trick to the LFS store.
    // Best-effort and flag-gated (off by default): anything not seeded here is
    // still fetched by the provisioning `git lfs pull`.
    linkLfsObjectsIntoClone(this.repoDir, sessionDir);
    // docs/198 — keep pnpm's relocated `/workspace/.pnpm-store` (a mountpoint at the
    // workspace root for pnpm repos) out of git via `.git/info/exclude`, so the
    // post-turn auto-commit never stages the store's internals. Non-tracked, so the
    // committed tree is unchanged; idempotent + best-effort.
    ensurePnpmStoreGitExcluded(sessionDir);
    // docs/150 §7 addendum: `git clone --local` and the root-side writes above
    // leave the whole fresh tree (worktree + `.git`) `root:root`. On a cold
    // session the entrypoint chowns the mount at boot, but a post-boot reclone
    // (warm-pool warming, cache recovery) runs after that one-shot, so without
    // this the tree is unwritable to the worker uid.
    //
    // docs/270 — this MUST come before the `git config` writes below, and it
    // MUST be the object-aware handback rather than a plain recursive chown.
    // Both halves were wrong before per-session uids made them visible:
    //
    //   - **Ordering.** Those writes go through `safeSimpleGit(sessionDir)`,
    //     which now drops to the session's own uid. Run against a tree that is
    //     still `root:root` they EACCES on `.git/config`, and session creation
    //     fails. It worked until now only because a root-owned tree meant "do
    //     not drop", which stopped being true the moment the session directory
    //     became the record instead of the tree.
    //   - **Object awareness.** `git clone --local` HARDLINKS `.git/objects`
    //     from the shared bare cache — measured: the cache and two clones report
    //     the same inode — and an inode has one owner across every link. A plain
    //     recursive chown therefore hands THIS session ownership, and so chmod
    //     and rewrite rights, over object files the cache and every sibling
    //     clone read. `handWorkspaceBackToWorker` composes the object-aware
    //     `.git` walk (which chowns object directories but never object files)
    //     with the worktree walk, which is exactly the split this needs.
    handWorkspaceBackToWorker(sessionDir);
    // Disable auto-gc in the session clone to prevent hardlink breakage
    const sessionGit = safeSimpleGit(sessionDir);
    await sessionGit.raw(["config", "gc.auto", "0"]);
    // Reset origin to the real remote URL (clone --local sets it to the bare
    // cache path). Credential-free: this write lands in the session clone's
    // `.git/config`, which is `/project/.git/config` inside the session and
    // plugin containers (docs/262 req 19).
    if (remoteUrl) {
      await sessionGit.raw(["remote", "set-url", "origin", credentialFreeRemote(remoteUrl, "cloneFromCache")]);
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

  /**
   * docs/183 Phase 3/4 — ancestry oracle for the overlay rolling-base publish
   * compare-and-swap. `git merge-base --is-ancestor a b` exits 0 iff `a` is an
   * ancestor of `b` (reflexively true when a === b), exit 1 when it isn't, and
   * exit 128 on an unknown commit. Run against the bare cache, which holds the
   * full default-branch history, so a candidate's commit can be ordered relative
   * to the current base's commit without any session checkout.
   *
   * We spawn git directly and inspect the exit code rather than using
   * `this.git.raw`: simple-git's `raw` resolves (does NOT reject) on
   * `--is-ancestor`'s exit-1, so a `try/raw/catch` would treat EVERY pair as an
   * ancestor — silently turning the publish CAS into "always advance" and
   * clobbering the base with behind/diverged candidates. Exit code 1 → false;
   * any other non-zero (unknown commit, git error) → false too, the safe
   * direction (decline the publish rather than clobber a healthy base).
   */
  isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const proc = spawn(
          "git",
          gitArgsWithHooksDisabled(["merge-base", "--is-ancestor", ancestor, descendant]),
          // The bare cache is ShipIt's own and root-owned, so the docs/266 drop
          // is a no-op — but it is resolved from the filesystem, not assumed.
          { cwd: this.repoDir, stdio: "ignore", ...gitSpawnOverridesForTree(this.repoDir) },
        );
        proc.on("error", () => resolve(false));
        proc.on("close", (code) => resolve(code === 0));
      } catch {
        resolve(false);
      }
    });
  }

  /**
   * docs/183 Phase 4 — resolve the current default-branch commit of the bare
   * cache (the value the overlay publish path passes as `currentDefaultCommit`).
   * A bare repo stores the branch at `refs/heads/<branch>`; resolve via
   * `getDefaultBranch` then `rev-parse`. Returns null if it can't be resolved
   * (the publish path then conservatively declines rather than guessing).
   */
  async resolveDefaultBranchCommit(remote = "origin"): Promise<string | null> {
    try {
      const branch = await this.getDefaultBranch(remote);
      const sha = await this.git.revparse([branch]);
      const trimmed = sha.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
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
