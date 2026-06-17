import simpleGit, { type SimpleGit, type LogResult } from "simple-git";
import fs from "node:fs";
import path from "node:path";
import { scanDiffForSecrets, redactSecretsInText, type SecretFinding } from "./secret-scan.js";

const DEFAULT_WORKSPACE_DIR = "/workspace";

/**
 * docs/198 — keep pnpm's relocated store out of git WITHOUT mutating any tracked
 * file. pnpm 11 ignores `npm_config_store_dir`/`store-dir` config and relocates
 * its content-addressable store to `<nearest mountpoint of project>/.pnpm-store`
 * when HOME's default store is on a different device than the project — i.e.
 * `/workspace/.pnpm-store` inside a session container, where we mount the shared
 * store. That mountpoint is visible to `git status` at the workspace root, and the
 * repo's own `.gitignore` doesn't cover it, so the post-turn auto-commit would
 * otherwise stage the store's internals (`.pnpm-store/v11/index.db`, …) onto the
 * branch (observed on the canary 2026-06-12).
 *
 * Writing the pattern to `.git/info/exclude` — a per-clone, NON-tracked ignore
 * list — keeps `git status` / `git add -A` from ever seeing it, with zero change
 * to the committed tree. Applied to every clone (not gated on the overlay flag):
 * pnpm's relocation happens regardless of our flag, so the exclude is a
 * universally-safe defensive entry (`.pnpm-store/` is never something you want
 * committed in any repo). Idempotent — appends the line only when absent.
 * Best-effort: a missing/non-writable `.git` (e.g. a worktree pointer file, or a
 * read-only fs in tests) must never block clone prep or a commit.
 */
export function ensurePnpmStoreGitExcluded(repoDir: string): void {
  const PNPM_STORE_EXCLUDE_ENTRY = ".pnpm-store/";
  const excludePath = path.join(repoDir, ".git", "info", "exclude");
  try {
    let contents = "";
    try {
      contents = fs.readFileSync(excludePath, "utf-8");
    } catch {
      // info/exclude may not exist yet — fall through to create it.
    }
    if (contents.split("\n").some((line) => line.trim() === PNPM_STORE_EXCLUDE_ENTRY)) {
      return;
    }
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const sep = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(excludePath, `${sep}${PNPM_STORE_EXCLUDE_ENTRY}\n`);
  } catch (err) {
    console.warn(
      `[git] failed to write .pnpm-store exclude to ${excludePath}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

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
  /**
   * docs/213 — likely secrets found in the staged diff. When non-empty, NO
   * commit was made: the whole commit is refused (the secret-bearing change
   * stays in the working tree for the agent to fix) and the caller surfaces a
   * persisted warning notice. Empty on every clean commit and on the conflict
   * refusal above.
   */
  secretFindings: SecretFinding[];
}

export class GitManager {
  private git: SimpleGit;
  private workspaceDir: string;

  /**
   * @param workspaceDir - Git working directory. Defaults to `/workspace`.
   *   Override in tests to use a temp directory.
   */
  constructor(workspaceDir?: string) {
    this.workspaceDir = workspaceDir ?? DEFAULT_WORKSPACE_DIR;
    this.git = simpleGit(this.workspaceDir);
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
    // docs/198 — defensively ensure pnpm's relocated `/workspace/.pnpm-store` is
    // excluded before we read status / stage. The primary write happens at clone
    // prep (RepoGit.cloneFromCache), but sessions cloned before this fix — and any
    // non-clone workspace — heal here on their next turn, so the store can never
    // leak into a commit. Idempotent + best-effort, so it never blocks the commit.
    ensurePnpmStoreGitExcluded(this.workspaceDir);
    const status = await this.git.status();
    const rebaseInProgress = await this.isRebaseInProgress();
    const conflictedFiles = [...status.conflicted];

    if (conflictedFiles.length > 0 || rebaseInProgress) {
      console.warn(
        "[git] autoCommit refused — git reports unresolved conflict state:",
        rebaseInProgress ? "rebase in progress;" : "",
        conflictedFiles.length > 0 ? `unmerged paths: ${conflictedFiles.join(", ")}` : "",
      );
      return { commitHash: null, conflictedFiles, rebaseInProgress, secretFindings: [] };
    }

    if (status.isClean()) {
      return { commitHash: null, conflictedFiles: [], rebaseInProgress: false, secretFindings: [] };
    }

    await this.git.add("-A");

    // docs/213 — secret-scan guard. Scan the STAGED diff (which now includes
    // new untracked files, since we just `git add -A`'d) for high-signal
    // credentials. If any are found, refuse the WHOLE commit — same posture as
    // the conflict refusal above: nothing is committed or pushed, and the
    // working tree is left intact (we `git reset` to unstage) so the agent can
    // fix the secret next turn. Cheap: one synchronous regex pass over the
    // staged diff, no extra git round-trips beyond the diff read.
    const secretFindings = scanDiffForSecrets(await this.stagedDiff());
    if (secretFindings.length > 0) {
      console.warn(
        "[git] autoCommit refused — likely secret(s) in staged diff:",
        secretFindings.map((f) => `${f.rule} in ${f.file}`).join(", "),
      );
      // Unstage so the working tree is preserved for the next turn. Best-effort:
      // a repo with no HEAD yet (no initial commit) has nothing to reset to.
      try {
        await this.git.reset(["--mixed"]);
      } catch {
        // no HEAD / nothing staged — safe to ignore.
      }
      return { commitHash: null, conflictedFiles: [], rebaseInProgress: false, secretFindings };
    }

    // docs/213 — the commit MESSAGE is derived from agent-authored turn text,
    // and the historical leak spread into commit messages too. A clean diff with
    // a secret in the summary must not write that secret into git history, so
    // scrub the message (the code still commits, just with a redacted summary).
    const message = redactSecretsInText(summary || "Claude turn");
    const result = await this.git.commit(message);
    const hash = result.commit || "";
    console.log("[git] Committed:", hash, message, "on branch:", status.current ?? "(detached)");
    return { commitHash: hash, conflictedFiles: [], rebaseInProgress: false, secretFindings: [] };
  }

  /**
   * docs/213 — the unified diff of everything currently staged (`git diff
   * --cached`). Used by the secret-scan guard in {@link autoCommit}; after a
   * `git add -A` this captures new untracked files too, which is exactly where
   * a leaked credential file would appear. Best-effort: returns "" on error
   * (e.g. no HEAD), so the scan simply finds nothing rather than blocking.
   */
  async stagedDiff(): Promise<string> {
    try {
      return await this.git.diff(["--cached"]);
    } catch {
      return "";
    }
  }

  /**
   * docs/213 — the unified diff introduced between two commits (`git diff
   * from..to`, two-dot: the cumulative change from `from` to `to`). Used by the
   * post-turn guard to scan commits the AGENT created itself this turn (which
   * `autoCommit` never staged) before they're auto-pushed. Callers must ensure
   * `from` is an ancestor of `to` so the range is purely the new commits — see
   * the moved-HEAD branch in `post-turn.ts`. Best-effort: "" on error.
   */
  async diffRange(from: string, to: string): Promise<string> {
    try {
      return await this.git.diff([`${from}..${to}`]);
    } catch {
      return "";
    }
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
   * docs/202 — TWO-DOT diff stat `<ref>..HEAD`: changes on HEAD's side only.
   *
   * Distinct from {@link diffStatVsBranch}, which uses a THREE-DOT
   * `<ref>...HEAD` (symmetric difference vs the merge base). Three-dot is the
   * squash-breaking comparison: after a squash merge the branch's commits never
   * enter the base's history, so a three-dot diff against the moved base picks
   * up *other people's* commits and reports spurious changes. Two-dot asks the
   * narrower question "what does HEAD's tree change relative to the ref's tree?"
   * — which, once the branch is rebased onto the current base, is empty for a
   * squash-merged branch with no new work and non-empty the moment real work
   * lands. Returns zeros if the ref can't be resolved.
   */
  async diffStatTwoDot(ref: string): Promise<{ insertions: number; deletions: number; files: number }> {
    try {
      const result = await this.git.diffSummary([`${ref}..HEAD`]);
      return { insertions: result.insertions, deletions: result.deletions, files: result.files.length };
    } catch {
      return { insertions: 0, deletions: 0, files: 0 };
    }
  }

  /**
   * docs/202 — squash-safe "has this merged branch progressed beyond its base?"
   * detection, local git only (no network).
   *
   * Returns true iff BOTH hold for `origin/<baseBranch>`:
   *   1. `merge-base(origin/<base>, HEAD) === rev-parse(origin/<base>)` — the
   *      branch has been rebased onto the *current* base tip (so the
   *      already-merged content is gone from the two-dot diff: a squash merge's
   *      commits replay as empty against the squash commit now in the base; a
   *      regular merge's commits are already there).
   *   2. The two-dot `git diff origin/<base>..HEAD` is non-empty — genuinely new
   *      work sits on top.
   *
   * Pre-rebase (merge-base ≠ base tip) we stay conservative and return false:
   * there is no reliable content diff against a moved base (three-dot breaks on
   * squash, two-dot picks up other commits), so a merged session keeps showing
   * "merged" until the user rebases. A missing `origin/<base>` also returns
   * false (fail-safe — stay merged).
   */
  async advancedBeyondMergedBase(baseBranch: string): Promise<boolean> {
    const baseRef = `origin/${baseBranch}`;
    let baseTip: string;
    try {
      baseTip = (await this.git.revparse(["--verify", baseRef])).trim();
    } catch {
      return false; // origin/<base> missing — fail safe, stay merged
    }
    if (!baseTip) return false;

    const mb = await this.mergeBase(baseRef, "HEAD");
    if (!mb || mb !== baseTip) return false; // not rebased onto the current base yet

    const { files } = await this.diffStatTwoDot(baseRef);
    return files > 0;
  }

  /**
   * Get per-file diff summary (files changed with insertions/deletions).
   * `binary` is true when git reports `-\t-` in --numstat (the canonical
   * binary signal). It's NOT inferred from `insertions === 0 && deletions === 0`
   * because pure renames, mode-only changes, and empty files also produce 0/0.
   * Returns an empty array if there are no commits or no changes.
   */
  async diffSummary(range?: string): Promise<{ file: string; insertions: number; deletions: number; binary: boolean }[]> {
    try {
      const result = await this.git.diffSummary([range ?? "HEAD~1...HEAD"]);
      return result.files.map((f) => ({
        file: f.file,
        insertions: (f as { insertions?: number }).insertions ?? 0,
        deletions: (f as { deletions?: number }).deletions ?? 0,
        binary: (f as { binary?: boolean }).binary === true,
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

  /**
   * Return true when the working tree has no staged or unstaged changes —
   * a public wrapper around `simple-git`'s `status().isClean()`. Needed by
   * the auto-resolve pre-flight (docs/146): the auto-path must never stash
   * silently, so a dirty tree defers the attempt instead of running the
   * rebase blindly. The underlying `this.git` field is private, so callers
   * outside this class can't reach `status()` directly.
   */
  async isClean(): Promise<boolean> {
    const status = await this.git.status();
    return status.isClean();
  }

  /**
   * Paths with uncommitted changes in the working tree — staged, unstaged,
   * and untracked. Includes both sides of a rename. Used to flag docs the
   * agent touched in the current turn before auto-commit has run.
   */
  async uncommittedPaths(): Promise<string[]> {
    const status = await this.git.status();
    const paths = new Set<string>();
    for (const f of status.files) paths.add(f.path);
    for (const r of status.renamed) {
      paths.add(r.from);
      paths.add(r.to);
    }
    return [...paths];
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

  /**
   * Read the remote's CURRENT tip sha for `branch` via a live `git ls-remote`
   * (a network query, independent of the local `refs/remotes/origin/*` tracking
   * ref). Returns null when the remote has no such branch.
   *
   * Used to compute a *non-stale* `--force-with-lease` expected value right
   * before a force push — see {@link forcePush}.
   */
  async remoteBranchSha(remote = "origin", branch?: string): Promise<string | null> {
    const currentBranch = branch ?? (await this.getCurrentBranch());
    try {
      const out = await this.git.listRemote(["--heads", remote, currentBranch]);
      // `<sha>\trefs/heads/<branch>` per matching ref; empty when absent.
      const line = out
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      if (!line) return null;
      const sha = line.split(/\s+/)[0];
      return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
    } catch {
      return null;
    }
  }

  /**
   * Force push the current branch, leasing against the remote's **live** tip.
   *
   * Why not a bare `--force-with-lease`: that form pins the lease to the local
   * remote-tracking ref `refs/remotes/origin/<branch>`. In the follow-up-PR flow
   * (a merged PR's branch is rebased onto the now-advanced base and gains new
   * work — docs/202), that tracking ref is stale: the remote branch was deleted
   * at merge (auto-delete / ShipIt's best-effort prune), or it simply was never
   * re-fetched for this branch. So the bare lease's expected value no longer
   * matches the remote and git rejects *every* push with `[rejected] (stale
   * info)` — repeatably, even right after a manual `git fetch`.
   *
   * Reading the live remote tip via {@link remoteBranchSha} makes the lease
   * correct post-rebase while keeping it a real lease, not a bare `--force`: if
   * the remote moves between the read and the push, the expected value no longer
   * matches and the push is still rejected (see {@link forcePushWithLease}).
   * ShipIt owns its feature branches, so the only legitimate remote states are
   * "the pre-rebase commits it pushed itself" or "deleted" — both resolved here.
   */
  async forcePush(remote = "origin", branch?: string): Promise<string> {
    const currentBranch = branch ?? (await this.getCurrentBranch());
    const expected = await this.remoteBranchSha(remote, currentBranch);
    return this.forcePushWithLease(remote, currentBranch, expected);
  }

  /**
   * Force push `branch` with an explicit lease: the remote ref must currently be
   * at `expectedRemoteSha`, or git rejects the push with `(stale info)` and the
   * remote is left untouched. Pass `null` when the remote branch is expected to
   * be absent — that push *creates* the ref, so there is nothing to clobber and
   * no lease is applied (a bare `--force-with-lease` would itself reject here,
   * leasing against the stale tracking ref that still names the deleted tip; a
   * concurrent create is still caught as a non-fast-forward by the plain push).
   */
  async forcePushWithLease(
    remote: string,
    branch: string,
    expectedRemoteSha: string | null,
  ): Promise<string> {
    const args = expectedRemoteSha
      ? [`--force-with-lease=${branch}:${expectedRemoteSha}`, "--set-upstream"]
      : ["--set-upstream"];
    await this.git.push(remote, branch, args);
    const msg = `Force pushed to ${remote}/${branch}`;
    console.log("[git]", msg);
    return msg;
  }

  /** Stage all changes (used after resolving conflicts before rebase --continue). */
  async stageAll(): Promise<void> {
    await this.git.add("-A");
  }

  /**
   * docs/214 — create-or-reset a local branch to `startPoint` and check it out
   * (`git checkout -B <branch> <startPoint>`). Used by the release-prepare flow
   * to build a deterministic `release/<version>` head branch off
   * `origin/<release-branch>`: the same invocation creates the branch on a first
   * run and force-resets it on a re-run, so a re-prepared release re-uses the
   * same head (and the same open PR) instead of spawning a duplicate.
   */
  async createBranchFrom(branch: string, startPoint: string): Promise<void> {
    await this.git.checkout(["-B", branch, startPoint]);
    console.log("[git] checkout -B", branch, "from", startPoint);
  }

  /**
   * docs/214 — alias of {@link createBranchFrom} (`git checkout -B`), named for
   * the re-run case where the caller's intent is "throw away the previous
   * attempt and reset `release/<version>` back to `origin/<base>`". The
   * higher-level refusal-to-clobber guard (a branch carrying commits the prepare
   * flow didn't author) lives in `release-prepare.ts`, not here — this is the
   * mechanical reset once that check has passed.
   */
  async resetBranchTo(branch: string, startPoint: string): Promise<void> {
    await this.createBranchFrom(branch, startPoint);
  }

  /**
   * docs/214 — cherry-pick one or more commits onto the current branch (hotfix
   * release payload). On a conflict the pick is aborted so the working tree is
   * left clean — committing a half-resolved pick onto the release branch would
   * publish a broken tree — and the offending sha is surfaced to the caller to
   * relay to the user. `git cherry-pick` applies the shas in the given order.
   */
  async cherryPick(shas: string[]): Promise<{ success: boolean; conflictedSha?: string; conflicts?: string[] }> {
    if (shas.length === 0) return { success: true };
    try {
      await this.git.raw(["cherry-pick", ...shas]);
      console.log("[git] cherry-picked", shas.join(" "));
      return { success: true };
    } catch (err: unknown) {
      const status = await this.git.status();
      // The sha being applied when the pick stopped — CHERRY_PICK_HEAD points at it.
      let conflictedSha: string | undefined;
      try {
        conflictedSha = (await this.git.revparse(["CHERRY_PICK_HEAD"])).trim() || undefined;
      } catch {
        conflictedSha = undefined;
      }
      try {
        await this.git.raw(["cherry-pick", "--abort"]);
      } catch {
        // abort may fail if the pick never properly started — best-effort cleanup.
      }
      if (status.conflicted.length > 0 || conflictedSha) {
        return {
          success: false,
          ...(conflictedSha ? { conflictedSha } : {}),
          conflicts: status.conflicted,
        };
      }
      throw err;
    }
  }

  /**
   * docs/214 — list tag names, optionally filtered to those matching a shell
   * glob `pattern` (e.g. `"v1.2.3-rc.*"`). Used by the prerelease path to find
   * the highest existing `-rc.N` for a base version so `{n}` auto-increments.
   * Returns an empty array on error or no matches.
   */
  async listTags(pattern?: string): Promise<string[]> {
    try {
      const args = ["tag", "--list", ...(pattern ? [pattern] : [])];
      const out = await this.git.raw(args);
      return out.split("\n").map((t) => t.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * docs/214 — the full commit message (subject + body) of a ref's tip, or null
   * when the ref can't be resolved. The release-prepare re-run guard reads the
   * remote head branch's tip message to decide whether the branch carries a
   * commit the prepare flow didn't author (no `Shipit-Release-Version` trailer)
   * before force-resetting it.
   */
  async tipCommitMessage(ref: string): Promise<string | null> {
    try {
      const out = await this.git.raw(["log", "-1", "--format=%B", ref]);
      return out;
    } catch {
      return null;
    }
  }

  /** Create an annotated tag at HEAD (or `ref`) and push it to `remote`. */
  async createAndPushTag(tag: string, message: string, remote = "origin", ref?: string): Promise<void> {
    const args = ["tag", "-a", tag, "-m", message, ...(ref ? [ref] : [])];
    await this.git.raw(args);
    await this.git.push(remote, tag);
    console.log("[git] created + pushed tag", tag);
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
    // docs/213 — same secret guard as autoCommit, on the path-scoped staged diff.
    // A marketplace skill install shouldn't be a hole in the "never commit a
    // credential" guarantee. On a finding: unstage and refuse (return null, the
    // caller's "nothing committed" path).
    const secretFindings = scanDiffForSecrets(await this.stagedDiff());
    if (secretFindings.length > 0) {
      console.warn(
        "[git] commitPaths refused — likely secret(s) in staged diff:",
        secretFindings.map((f) => `${f.rule} in ${f.file}`).join(", "),
      );
      try {
        await this.git.reset(["--mixed"]);
      } catch {
        // no HEAD / nothing staged — safe to ignore.
      }
      return null;
    }
    const safeMessage = redactSecretsInText(message);
    const result = await this.git.commit(safeMessage);
    const hash = result.commit || "";
    console.log("[git] Committed (path-scoped):", hash, safeMessage);
    return hash;
  }

}
