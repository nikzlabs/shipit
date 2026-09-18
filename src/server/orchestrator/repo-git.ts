import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { type SimpleGit } from "simple-git";
import { safeSimpleGit, gitArgsWithHooksDisabled } from "../shared/git-hooks-guard.js";
import { gitSpawnOverridesForTree } from "../shared/git-tree-uid.js";
import {
  type GitRemoteCredential,
  type GitRemoteCredentialResolver,
  gitCredentialConfig,
  gitCredentialEnv,
  resolveTreeRemoteCredential,
  sanitizeGitEnv,
  withPreemptiveAuthFallback,
} from "../shared/git-remote-credential.js";
import { ensurePnpmStoreGitExcluded } from "../shared/git.js";
import { hasUrlCredentials, stripRemoteUrlCredentials } from "./git-utils.js";
import { handWorkspaceBackToWorker } from "./session-worker-uid.js";
import { ensureSharedTreeOwnedByShipIt } from "./shared-tree-ownership.js";
import { linkLfsObjectsIntoClone } from "./git-lfs-store.js";

// Some callers construct RepoGit directly; shared-cache invariants belong on its operations.
export async function ensureBareCache(
  cacheDir: string,
  repoUrl: string,
  createRepoGit: (dir: string, credential?: GitRemoteCredential) => RepoGit,
  credential?: GitRemoteCredential,
): Promise<{ git: RepoGit; recovered: boolean }> {
  const headPath = path.join(cacheDir, "HEAD");
  // eslint-disable-next-line no-restricted-syntax -- stat existence-check idiom
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

// Clone URLs are persisted in git config, which session and plugin containers can read.
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

export {
  type GitRemoteCredential,
  type GitRemoteCredentialResolver,
  type RemoteOrigin,
  sanitizeGitEnv,
  gitCredentialConfig,
  gitCredentialEnv,
  parseRemoteOrigin,
} from "../shared/git-remote-credential.js";

export class RepoGit {
  private git: SimpleGit;
  readonly repoDir: string;
  private readonly explicitCredential: GitRemoteCredential | undefined;
  private readonly resolveRemoteCredential: GitRemoteCredentialResolver | undefined;

  constructor(
    repoDir: string,
    credential?: GitRemoteCredential,
    resolveRemoteCredential?: GitRemoteCredentialResolver,
  ) {
    this.repoDir = repoDir;
    this.explicitCredential = credential;
    this.resolveRemoteCredential = resolveRemoteCredential;
    // Local operations must not inherit remote credentials.
    this.git = safeSimpleGit(repoDir);
  }

  private gitFor(credential: GitRemoteCredential | null): SimpleGit {
    if (!credential) return safeSimpleGit(this.repoDir);
    return safeSimpleGit(this.repoDir, {
      config: gitCredentialConfig(credential),
      // These overrides enable ShipIt's helper and config; inherited GIT_CONFIG_* is sanitized.
      unsafe: {
        allowUnsafeConfigPaths: true,
        allowUnsafeEditor: true,
        allowUnsafeCredentialHelper: true,
        allowUnsafeConfigEnvCount: true,
      },
    }).env({
      ...sanitizeGitEnv(process.env),
      ...gitCredentialEnv(credential),
      GIT_TERMINAL_PROMPT: "0",
    });
  }

  private async remoteCredential(remote: string, url?: string): Promise<GitRemoteCredential | null> {
    if (this.explicitCredential) return this.explicitCredential;
    return resolveTreeRemoteCredential(
      this.repoDir,
      remote,
      this.resolveRemoteCredential,
      url === undefined ? undefined : async () => url,
    );
  }

  private async withRemote<T>(
    what: string,
    remote: string,
    url: string | undefined,
    run: (git: SimpleGit) => Promise<T>,
  ): Promise<T> {
    const credential = await this.remoteCredential(remote, url);
    // Falling back from a caller-scoped token to the host PAT would widen its access.
    if (this.explicitCredential) return run(this.gitFor(credential));
    return withPreemptiveAuthFallback(credential, what, (cred) => run(this.gitFor(cred)));
  }

  async clone(url: string, branch?: string): Promise<void> {
    const args = ["clone", credentialFreeRemote(url, "clone"), "."];
    if (branch) args.push("--branch", branch);
    await this.withRemote("clone", "origin", url, (git) => git.raw(args));
  }

  async cloneBare(url: string): Promise<void> {
    await this.withRemote("cloneBare", "origin", url, (git) => git.raw([
      "clone", "--bare", credentialFreeRemote(url, "cloneBare"), ".",
    ]));
    await this.ensureFetchRefspec();
    console.log("[git] Cloned bare repo:", this.repoDir);
  }

  // clone --bare sets no fetch refspec; without this, fetch leaves local heads frozen.
  private async ensureFetchRefspec(): Promise<void> {
    await this.git.raw([
      "config",
      "remote.origin.fetch",
      "+refs/heads/*:refs/heads/*",
    ]);
  }

  async setRemoteUrl(url: string, remote = "origin"): Promise<void> {
    await this.git.raw(["remote", "set-url", remote, credentialFreeRemote(url, "setRemoteUrl")]);
  }

  async readHead(): Promise<string> {
    try {
      return (await this.git.raw(["rev-parse", "HEAD"])).trim();
    } catch {
      return "unknown";
    }
  }

  lastFetchAgeMs(): number | null {
    const markerPath = path.join(this.repoDir, ".shipit-last-fetch");
    try {
      return Date.now() - fs.statSync(markerPath).mtimeMs;
    } catch {
      return null;
    }
  }

  async fetchCache(ttlMs = 60_000): Promise<void> {
    const markerPath = path.join(this.repoDir, ".shipit-last-fetch");
    try {
      const stat = fs.statSync(markerPath);
      if (Date.now() - stat.mtimeMs < ttlMs) {
        return;
      }
    } catch {
      // Missing marker requires a fetch.
    }
    // Repair ownership before git resolves which uid may write the shared tree.
    ensureSharedTreeOwnedByShipIt(this.repoDir, "bare-cache fetch");
    await this.ensureFetchRefspec();
    const headBefore = await this.readHead();
    await this.withRemote("bare-cache fetch", "origin", undefined, (git) => git.raw([
      "fetch", "--all", "--force", "--prune",
    ]));
    fs.writeFileSync(markerPath, String(Date.now()));
    const headAfter = await this.readHead();
    const advanced = headBefore !== headAfter ? "advanced" : "unchanged";
    console.log(
      `[git] Fetched bare cache: ${this.repoDir} HEAD ${headBefore.slice(0, 9)} → ${headAfter.slice(0, 9)} (${advanced})`,
    );
    try {
      await this.git.raw(["gc", "--auto"]);
    } catch (err) {
      console.warn("[git] gc --auto failed (non-fatal):", String(err));
    }
  }

  async cloneFromCache(sessionDir: string, remoteUrl?: string): Promise<void> {
    // Clone as the shared cache's owner; a foreign uid cannot traverse the session parent.
    ensureSharedTreeOwnedByShipIt(this.repoDir, "session clone from bare cache");
    await safeSimpleGit().raw(["clone", "--local", this.repoDir, sessionDir]);
    // clone --local omits the LFS store.
    linkLfsObjectsIntoClone(this.repoDir, sessionDir);
    ensurePnpmStoreGitExcluded(sessionDir);
    // Hand back before dropped-uid config writes. Never chown hardlinked object files.
    handWorkspaceBackToWorker(sessionDir);
    // Auto-gc would break shared object hardlinks.
    const sessionGit = safeSimpleGit(sessionDir);
    await sessionGit.raw(["config", "gc.auto", "0"]);
    if (remoteUrl) {
      await sessionGit.raw(["remote", "set-url", "origin", credentialFreeRemote(remoteUrl, "cloneFromCache")]);
    }
    console.log("[git] Cloned from cache:", this.repoDir, "→", sessionDir);
  }

  async fetch(remote: string, branch: string): Promise<void> {
    await this.withRemote("fetch", remote, undefined, (git) => git.fetch(remote, branch, ["--force"]));
  }

  async getDefaultBranch(remote = "origin"): Promise<string> {
    try {
      const head = await this.git.raw(["symbolic-ref", `refs/remotes/${remote}/HEAD`]);
      const match = /refs\/remotes\/[^/]+\/(.+)/.exec(head.trim());
      if (match) return match[1];
    } catch {
      // Remote HEAD not set.
    }

    // Bare repositories point HEAD directly at a local branch.
    try {
      const head = await this.git.raw(["symbolic-ref", "HEAD"]);
      const match = /refs\/heads\/(.+)/.exec(head.trim());
      if (match) return match[1];
    } catch {
      // No HEAD.
    }

    return "main";
  }

  // simple-git raw resolves on exit 1 here; inspect the exit code directly for ancestry.
  isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const proc = spawn(
          "git",
          gitArgsWithHooksDisabled(["merge-base", "--is-ancestor", ancestor, descendant]),
          { cwd: this.repoDir, stdio: "ignore", ...gitSpawnOverridesForTree(this.repoDir) },
        );
        proc.on("error", () => resolve(false));
        proc.on("close", (code) => resolve(code === 0));
      } catch {
        resolve(false);
      }
    });
  }

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

  // Pushes cannot succeed anonymously; do not replace an auth failure with a fallback error.
  async deleteBranch(branchName: string): Promise<void> {
    const git = this.gitFor(await this.remoteCredential("origin"));
    try {
      await git.raw(["push", "origin", "--delete", branchName]);
      console.log("[git] Deleted remote branch:", branchName);
    } catch (err) {
      if (String(err).includes("remote ref does not exist")) {
        console.log("[git] Remote branch not found (already gone or never pushed):", branchName);
        return;
      }
      throw err;
    }
  }

  async isEmpty(): Promise<boolean> {
    try {
      const result = await this.git.log({ maxCount: 1 });
      return result.all.length === 0;
    } catch {
      return true;
    }
  }

  async createInitialCommit(): Promise<void> {
    await this.git.commit("Initial commit", { "--allow-empty": null });
    console.log("[git] Created initial commit in bare cache");
  }
}
