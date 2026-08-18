import { type SimpleGit, type LogResult } from "simple-git";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { scanDiffForSecrets, redactSecretsInText, type SecretFinding } from "./secret-scan.js";
import { safeSimpleGit, gitArgsWithHooksDisabled } from "./git-hooks-guard.js";
import {
  type GitRemoteCredentialResolver,
  credentialledGit,
  resolveTreeRemoteCredential,
} from "./git-remote-credential.js";
import { type GitTreeUidDeps, gitSpawnOverridesForTree } from "./git-tree-uid.js";
import { pushLfsObjects } from "./git-lfs-push.js";

/** Construction-time wiring for {@link GitManager}. */
export interface GitManagerOptions {
  /**
   * docs/266-orchestrator-git-trust-boundary E3 (planning#404) — mints the credential a **dropped-uid** remote
   * op authenticates with. Wired at `createGitManager` (`app-di.ts`); omitted
   * everywhere else, and then every remote op behaves exactly as it did before
   * this existed.
   */
  resolveRemoteCredential?: GitRemoteCredentialResolver;
  /**
   * Injection seam for the uid-drop decision, so a test can exercise the
   * dropped-uid branch. `resolveGitTreeUid` answers "no drop" for any process
   * that is not root, and a session container has no root and refuses
   * `unshare -r` — so without this the branch this whole feature exists for is
   * unreachable from a test.
   */
  gitTreeUidDeps?: GitTreeUidDeps;
}

const DEFAULT_WORKSPACE_DIR = "/workspace";

/** Bound on {@link GitManager}'s stderr capture — enough for git's warnings, not a leak. */
const STDERR_TAIL_LIMIT = 8192;

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
  ensureGitExcluded(repoDir, [".pnpm-store/"]);
}

/**
 * Append patterns to a clone's `.git/info/exclude`, once each.
 *
 * Generalized from the pnpm case above because docs/262 needs the same
 * property for a second reason: a plugin repository's skills are materialized
 * into the workspace's skill roots so the agent can find them (req 22), and
 * "projects never keep copies" means the post-turn `git add -A` must never see
 * them. Same constraint, same answer — a per-clone, non-tracked ignore list
 * leaves the committed tree and every tracked file untouched.
 *
 * Idempotent, and never throws: a missing or non-writable `.git` (a worktree
 * pointer file, a read-only fs in tests) must not block clone prep or a
 * commit. It DOES report whether the entries are in force, because a caller
 * that is about to write files it promised would stay out of git needs to know
 * that the promise held — see `plugin-skills.ts`.
 */
export function ensureGitExcluded(repoDir: string, entries: readonly string[]): boolean {
  const excludePath = path.join(repoDir, ".git", "info", "exclude");
  try {
    let contents = "";
    try {
      contents = fs.readFileSync(excludePath, "utf-8");
    } catch {
      // info/exclude may not exist yet — fall through to create it.
    }
    const present = new Set(contents.split("\n").map((line) => line.trim()));
    const missing = entries.filter((entry) => !present.has(entry));
    if (missing.length === 0) return true;
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const sep = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(excludePath, `${sep}${missing.join("\n")}\n`);
    return true;
  } catch (err) {
    console.warn(
      `[git] failed to write exclude entries to ${excludePath}:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/**
 * Replace a delimited, ShipIt-owned block inside `.git/info/exclude`.
 *
 * {@link ensureGitExcluded} appends and never removes, which is right for a
 * fixed pattern like `.pnpm-store/`. docs/262's plugin skills need the
 * opposite: the entries are the EXACT directories materialized right now, so
 * they change as a declaration changes and stale ones must go.
 *
 * Exact names rather than a wildcard is the point. A pattern broad enough to
 * cover "whatever ShipIt might write" also hides whatever the USER happens to
 * name that way — an untracked directory of theirs, or a marketplace plugin
 * whose own path-scoped `git add` would then fail as an ignored path. Listing
 * what was actually written can hide nothing else.
 *
 * Returns whether the block is in force. Never throws. Last writer wins: this
 * is a read-modify-write with no lock, which is sound here because the only
 * writers are ShipIt's own prepare pass (serialized per session) and clone
 * prep, which runs before a container exists.
 */
export function ensureGitExcludedBlock(
  repoDir: string,
  blockName: string,
  entries: readonly string[],
): boolean {
  const begin = `# BEGIN ${blockName} (managed by ShipIt — do not edit)`;
  const end = `# END ${blockName}`;
  const excludePath = path.join(repoDir, ".git", "info", "exclude");
  try {
    let contents = "";
    try {
      contents = fs.readFileSync(excludePath, "utf-8");
    } catch {
      // info/exclude may not exist yet — fall through to create it.
    }
    const lines = contents.split("\n");
    const from = lines.indexOf(begin);
    // The END must come AFTER the BEGIN we found. Searching the whole file for
    // it lets a truncated block (a BEGIN with no END, from an interrupted
    // write) swallow everything up to the NEXT run's END — including the
    // user's own ignore rules, which is how someone loses a rule that was
    // keeping a secret out of a commit (review finding). With no matching END,
    // drop the orphan BEGIN line alone and leave every other line where it is.
    const to = from === -1 ? -1 : lines.indexOf(end, from + 1);
    const kept = from === -1
      ? lines
      : [...lines.slice(0, from), ...lines.slice(to === -1 ? from + 1 : to + 1)];
    const block = entries.length > 0 ? [begin, ...entries, end] : [];
    const next = [...trimTrailingBlanks(kept), ...block].join("\n");
    const normalized = next.endsWith("\n") || next === "" ? next : `${next}\n`;
    if (normalized === contents) return true;
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    // Written via a temp file and renamed: a partial write here is not a
    // cosmetic problem — a truncated exclude file silently stops ignoring
    // whatever its lost lines covered.
    const tmp = `${excludePath}.shipit-tmp-${process.pid}`;
    fs.writeFileSync(tmp, normalized);
    fs.renameSync(tmp, excludePath);
    return true;
  } catch (err) {
    console.warn(
      `[git] failed to write the ${blockName} exclude block to ${excludePath}:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

function trimTrailingBlanks(lines: readonly string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out;
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
  /**
   * docs/266-orchestrator-git-trust-boundary reqs 14 + 15 — the workspace held content this git could not read.
   *
   * Only reachable once orchestrator git runs as the session's uid rather than
   * as root (`git-tree-uid.ts`): root reads everything, so before that change
   * neither state could occur. Both were measured against git 2.39.5; the table
   * is in `docs/266-orchestrator-git-trust-boundary/plan.md` §2.
   *
   *   - `omitted` — an unreadable **directory**. `status` and `add -A` both exit
   *     **0**, emitting only `warning: could not open directory` on stderr,
   *     and the subtree is silently missing from the commit. The commit still
   *     lands. This is the one the exit codes cannot tell apart from a turn that
   *     genuinely changed nothing, which is why it is detected from stderr.
   *   - `blocked` — an unreadable **file**. `add -A` exits **128** and stages
   *     NOTHING, including every unrelated file the turn changed, so the whole
   *     turn stays uncommitted.
   *
   * `null` on every ordinary commit. The caller MUST surface both, and must say
   * different things about them: `omitted` is "this commit is short", `blocked`
   * is "this commit did not happen".
   */
  unreadable: UnreadableWorkspace | null;
}

/** See {@link AutoCommitResult.unreadable}. */
export type UnreadableWorkspace =
  | { kind: "omitted"; detail: string }
  | { kind: "blocked"; detail: string };

/**
 * git's own words for the two states, matched on MESSAGE TEXT and never on an
 * exit code.
 *
 * That is not a stylistic choice. `errorDetectionPlugin`
 * (`simple-git/dist/cjs/index.js:1364-1374`) receives `exitCode` in its context
 * and builds `new GitError(void 0, stderr)` without carrying it onto the thrown
 * error — verified by running it — so `err.exitCode` is `undefined` by
 * construction. A detector keyed on the exit code would look correct in review
 * and never fire.
 *
 * ## Matching English is a dependency, and it is bounded on purpose
 *
 * Message text is translated when git runs under a non-C locale, so the
 * orchestrator pins `LC_ALL=C` on the process every orchestrator-side git
 * inherits (`git-config.ts`, which explains why simple-git's own options cannot
 * carry it). That makes the wording git's *source* wording rather than a
 * property of the deployment's locale.
 *
 * What still drifts is git's own wording across versions, and the two states
 * pay differently for it:
 *
 *   - **`blocked` does not depend on this regex to be reported.** `add -A`
 *     REJECTS, and the rejection alone proves the turn committed nothing —
 *     `autoCommit` rethrows what it cannot classify and `post-turn.ts` reports
 *     every uncommitted turn from the throw itself (req 15). The regex only
 *     buys the tailored "fix that path's permissions" advice and the path.
 *   - **`omitted` does.** git exits 0 and the warning on stderr is the only
 *     trace there is, so a wording change here means silence again. That is the
 *     residual, recorded rather than papered over; `git-unreadable.test.ts`
 *     fails on it for the git binary the tests run against.
 *
 * The file regex is deliberately keyed on the PERMISSION cause and not on
 * `unable to index file`, which git also emits for an EIO or a file deleted
 * between `status` and `add`. Matching that cause-agnostically told the user to
 * "fix that path's permissions" for failures that had nothing to do with
 * permissions (review finding, planning#407).
 */
const UNREADABLE_DIR_RE = /could not open directory\s+'([^']+)'/;
const UNREADABLE_FILE_RE = /open\("([^"]+)"\): Permission denied/;

/**
 * Is a rejected `git add -A` the measured unreadable-FILE case, and for which
 * path? `null` for every other cause.
 *
 * Exported for its test. A real-git test proves the LIVE message still matches
 * this; only a unit test can prove the messages that must NOT match — an EIO, a
 * file deleted between `status` and `add` — since neither can be staged on
 * demand in a container. Both halves are needed: the first fails when git's
 * wording drifts, the second fails if the match ever widens back to
 * `unable to index file` (planning#407).
 */
export function classifyUnreadableAddFailure(message: string): UnreadableWorkspace | null {
  const blocked = UNREADABLE_FILE_RE.exec(message);
  return blocked ? { kind: "blocked", detail: blocked[1] } : null;
}

export class GitManager {
  private git: SimpleGit;
  private workspaceDir: string;
  /**
   * Rolling capture of the last git invocation's stderr, for docs/266's
   * `omitted` detection.
   *
   * simple-git resolves a zero-exit task as success and does NOT surface
   * stderr, so `warning: could not open directory` reaches nobody by default —
   * a turn commits short and every exit code says it went fine. An
   * `outputHandler` is the only hook that sees that stream on the success path.
   * Bounded: only the tail matters, and a runaway git must not grow the heap.
   */
  private stderrTail = "";

  /**
   * docs/266-orchestrator-git-trust-boundary E3 (planning#404) — mints the credential a **dropped-uid** remote
   * op authenticates with. Undefined outside the orchestrator (the session
   * worker constructs a `GitManager` too) and in tests, where every remote op
   * behaves exactly as it did before this existed.
   */
  private readonly resolveRemoteCredential: GitRemoteCredentialResolver | undefined;

  /** Test seam — see {@link GitManagerOptions.gitTreeUidDeps}. */
  private readonly gitTreeUidDeps: GitTreeUidDeps | undefined;

  /**
   * @param workspaceDir - Git working directory. Defaults to `/workspace`.
   *   Override in tests to use a temp directory.
   * @param options.resolveRemoteCredential - see
   *   {@link GitManager.remoteGit}. Wired at `createGitManager` (`app-di.ts`).
   */
  constructor(workspaceDir?: string, options?: GitManagerOptions) {
    this.resolveRemoteCredential = options?.resolveRemoteCredential;
    this.gitTreeUidDeps = options?.gitTreeUidDeps;
    this.workspaceDir = workspaceDir ?? DEFAULT_WORKSPACE_DIR;
    // planning#384 — `safeSimpleGit`, never bare `simpleGit`: this class drives
    // commit/merge/rebase/checkout/push against a tree that untrusted plugin
    // code can write `.git/hooks/*` into, from a process that is root in the
    // orchestrator container. See `git-hooks-guard.ts`.
    this.git = safeSimpleGit(this.workspaceDir).outputHandler(
      (_command, _stdout, stderr) => {
        stderr.on("data", (chunk: Buffer | string) => {
          this.stderrTail = (this.stderrTail + String(chunk)).slice(-STDERR_TAIL_LIMIT);
        });
      },
    );
  }

  /** Start a fresh stderr capture window around a group of git calls. */
  private resetStderr(): void {
    this.stderrTail = "";
  }

  /**
   * The git working directory this manager operates on. Read-only: callers that
   * need to run something git can't express through this class (the diff
   * service's `git lfs smudge`, say) get the path, never the ability to retarget
   * an existing manager.
   */
  get dir(): string {
    return this.workspaceDir;
  }

  /**
   * The git instance a **remote** operation on `remote` should run through
   * (docs/266-orchestrator-git-trust-boundary E3, planning#404).
   *
   * Everything below the first two guards is the dropped-uid path and nothing
   * else. A root-side git — the bare cache, `/opt/shipit`, local mode, the
   * session worker, every test — gets `this.git` back and is byte-for-byte
   * unchanged: it reads the orchestrator's global helper, which reads the
   * root-only PAT file (`git-config.ts`).
   *
   * A dropped-uid git cannot read that file. It is handed its own credential
   * here instead — a short-lived, single-repo installation token when a GitHub
   * App is configured, and the PAT when one is not, which is precisely what the
   * session container's own broker would give the agent
   * (`getRepoScopedGitCredential`, docs/172 Gap 2-R). So a payload that
   * executes during a git op and steals it gains nothing the session did not
   * already have — requirement 11's argument, now true of the credential and
   * not only of the uid.
   *
   * **Availability is the constraint that shapes the fallbacks** (req 6, and
   * `CLAUDE.md` invariant 2: the post-turn auto-push is not optional). Every
   * step that can fail to produce a credential falls back to `this.git` rather
   * than throwing, so the worst case is the authentication behaviour that
   * shipped with E1, never a push that cannot run. The resolver itself is
   * deadline-bounded and PAT-backed on its own side (`services/github.ts`).
   *
   * Note the *commit* path never reaches here at all — `autoCommit` is purely
   * local, so it acquires no network dependency from this change.
   */
  private async remoteGit(remote: string): Promise<SimpleGit> {
    const credential = await resolveTreeRemoteCredential(
      this.workspaceDir,
      remote,
      this.resolveRemoteCredential,
      async () => {
        const remotes = await this.git.getRemotes(true);
        const match = remotes.find((r) => r.name === remote);
        return match?.refs.push || match?.refs.fetch || undefined;
      },
      this.gitTreeUidDeps,
    );
    if (!credential) return this.git;
    return credentialledGit(this.workspaceDir, credential);
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

  /** Resolve an arbitrary ref (branch, tag, `origin/main`, sha) to its commit
   * hash, or null if it doesn't resolve. */
  async getRefHash(ref: string): Promise<string | null> {
    try {
      const hash = await this.git.revparse(["--verify", ref]);
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
    // docs/266 — capture window for the two permission states. Opened before the
    // first git call so `status`'s own warning is caught: `status` is where the
    // unreadable-directory warning first appears, and it exits 0.
    this.resetStderr();
    const status = await this.git.status();
    // docs/266-orchestrator-git-trust-boundary req 14 — classify the unreadable-DIRECTORY warning HERE, off
    // `status`, not after the staging step.
    //
    // `status` is where git first emits it, and every return below this point
    // is a path where the warning would otherwise be dropped. The clean-tree
    // return is the one that matters: when the ONLY changes are inside the
    // unreadable directory, git reports "nothing to commit, working tree clean"
    // and exits 0 while warning on stderr — measured — so `autoCommit` would
    // report a clean tree, make no commit, and say nothing, which is precisely
    // the silent case req 14 exists for. Detecting after `add -A` missed it.
    const omittedMatch = UNREADABLE_DIR_RE.exec(this.stderrTail);
    const omitted: UnreadableWorkspace | null = omittedMatch
      ? { kind: "omitted", detail: omittedMatch[1] }
      : null;
    if (omitted) {
      console.warn(
        `[git] autoCommit could not read ${omitted.detail} — its contents are `
        + "omitted from this commit. The commit itself still lands.",
      );
    }
    const rebaseInProgress = await this.isRebaseInProgress();
    const conflictedFiles = [...status.conflicted];

    if (conflictedFiles.length > 0 || rebaseInProgress) {
      console.warn(
        "[git] autoCommit refused — git reports unresolved conflict state:",
        rebaseInProgress ? "rebase in progress;" : "",
        conflictedFiles.length > 0 ? `unmerged paths: ${conflictedFiles.join(", ")}` : "",
      );
      return { commitHash: null, conflictedFiles, rebaseInProgress, secretFindings: [], unreadable: omitted };
    }

    if (status.isClean()) {
      // Not necessarily clean — see the classification above. `omitted` here means
      // git could not SEE the changes, not that there were none.
      return { commitHash: null, conflictedFiles: [], rebaseInProgress: false, secretFindings: [], unreadable: omitted };
    }

    // docs/266-orchestrator-git-trust-boundary req 15 — an unreadable FILE makes `add -A` exit 128 and stage
    // NOTHING, including every unrelated file this turn changed. simple-git
    // rejects with a GitError carrying git's stderr (verified by running it);
    // `err.exitCode` is undefined by construction, so classify on the message.
    // Caught rather than thrown on: a throw here reaches `postTurnStep`, which
    // logs and continues — correct for a step that was not the commit, and this
    // IS the commit. Returning lets the caller tell the user their turn produced
    // nothing, which a log line does not.
    try {
      await this.git.add("-A");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const blocked = classifyUnreadableAddFailure(message);
      // Anything else — an EIO, a file deleted between `status` and `add`, a
      // full disk — is NOT the measured permission case and must not be dressed
      // up as one. It is still a turn that committed nothing, so it is still
      // req 15's subject: the caller reports it from the throw (`post-turn.ts`
      // catches, tells the user the turn was not committed, and rethrows).
      if (!blocked) throw err;
      console.error(
        `[git] autoCommit staged NOTHING — cannot read ${blocked.detail}. `
        + "The whole turn is uncommitted and still in the working tree.",
      );
      return {
        commitHash: null,
        conflictedFiles: [],
        rebaseInProgress: false,
        secretFindings: [],
        unreadable: blocked,
      };
    }

    // `add -A` can surface the same warning for a directory `status` already
    // flagged; re-read so a path only visible at staging time is still caught.
    const stagedOmitted = UNREADABLE_DIR_RE.exec(this.stderrTail);
    const unreadable: UnreadableWorkspace | null = omitted
      ?? (stagedOmitted ? { kind: "omitted", detail: stagedOmitted[1] } : null);

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
      return { commitHash: null, conflictedFiles: [], rebaseInProgress: false, secretFindings, unreadable };
    }

    // docs/213 — the commit MESSAGE is derived from agent-authored turn text,
    // and the historical leak spread into commit messages too. A clean diff with
    // a secret in the summary must not write that secret into git history, so
    // scrub the message (the code still commits, just with a redacted summary).
    const message = redactSecretsInText(summary || "Claude turn");
    const result = await this.git.commit(message);
    const hash = result.commit || "";
    console.log("[git] Committed:", hash, message, "on branch:", status.current ?? "(detached)");
    return { commitHash: hash, conflictedFiles: [], rebaseInProgress: false, secretFindings: [], unreadable };
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

  /**
   * Upload the Git LFS objects `branch` references, immediately before the ref
   * push that would otherwise reference them without sending them.
   *
   * Orchestrator-side git disables every hook (planning#384), and the git-lfs
   * `pre-push` hook is the only thing an ordinary `git push` uses to transfer
   * LFS objects — so without this the push sends pointers whose objects never
   * left the machine and GitHub rejects it with `GH008`. See
   * `git-lfs-push.ts` for the incident and for why the fix is an explicit
   * subcommand rather than re-enabling hooks.
   *
   * Best-effort by construction: a failure here is logged and the ref push runs
   * anyway (`CLAUDE.md` post-turn invariant 2 — the auto-push may not gain a new
   * way to fail). Whatever the server then says is classified by
   * `classifyPushFailure`, which knows GH008 is not a divergence.
   *
   * Deliberately NOT applied to {@link createAndPushTag}: a tag push publishes a
   * ref to commits the branch push already delivered, so it references no object
   * the remote lacks.
   */
  private async uploadLfsObjects(git: SimpleGit, remote: string, branch: string): Promise<void> {
    const outcome = await pushLfsObjects(git, remote, branch);
    if (outcome.status === "pushed") {
      console.log(`[git] Uploaded Git LFS objects for ${remote}/${branch}`);
    } else if (outcome.status === "failed") {
      console.warn(
        `[git] git lfs push ${remote} ${branch} failed — the ref push may be rejected `
        + `with GH008 (unknown Git LFS object): ${outcome.detail}`,
      );
    }
  }

  /** Push to a remote. Returns a summary string. */
  async push(remote = "origin", branch?: string): Promise<string> {
    const currentBranch = branch ?? (await this.getCurrentBranch());
    const git = await this.remoteGit(remote);
    await this.uploadLfsObjects(git, remote, currentBranch);
    await git.push(remote, currentBranch, ["--set-upstream"]);
    const msg = `Pushed to ${remote}/${currentBranch}`;
    console.log("[git]", msg);
    return msg;
  }

  /** Pull from a remote. Returns a summary string. */
  async pull(remote = "origin", branch?: string): Promise<string> {
    const currentBranch = branch ?? (await this.getCurrentBranch());
    await (await this.remoteGit(remote)).pull(remote, currentBranch);
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
   * Every diff-stat surface (PR card, diff dialog, re-arm detection) funnels
   * through this `--numstat` call so their numbers can never disagree.
   *
   * `--numstat` is load-bearing: simple-git's default `--stat` parsing derives
   * per-file insertions/deletions by counting the `+`/`-` characters of git's
   * histogram bar, which git SCALES DOWN to fit the stat width — on large
   * diffs those per-file counts (and any total summed from them) are off by
   * orders of magnitude. The numstat columns are exact.
   */
  private async numstatSummary(range: string): Promise<{
    insertions: number;
    deletions: number;
    files: { file: string; insertions: number; deletions: number; binary: boolean }[];
  }> {
    const result = await this.git.diffSummary(["--numstat", range]);
    return {
      insertions: result.insertions,
      deletions: result.deletions,
      files: result.files.map((f) => ({
        file: f.file,
        insertions: (f as { insertions?: number }).insertions ?? 0,
        deletions: (f as { deletions?: number }).deletions ?? 0,
        binary: (f as { binary?: boolean }).binary === true,
      })),
    };
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
        const result = await this.numstatSummary(`${ref}...HEAD`);
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
      const result = await this.numstatSummary(`${ref}..HEAD`);
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
   *
   * **Precondition — the caller MUST have fetched.** This reads `origin/<base>`
   * from the local clone, and that ref only moves when this clone fetches. On a
   * STALE ref clause 1 is trivially satisfied (the merge-base of a branch and
   * its own fork point *is* that fork point), so the check reports "progressed"
   * for a branch that was never rebased and carries only already-merged work.
   * Every caller therefore freshens the ref first — see
   * `services/pr-rearm.ts#freshenBaseRef`.
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
   * docs/216 — true iff HEAD points at exactly the `origin/<baseBranch>` tip,
   * i.e. the branch was reset/fast-forwarded back onto the base and carries no
   * commits of its own (the counterpart to {@link advancedBeyondMergedBase}).
   *
   * Used to re-arm a MERGED session whose branch was reset to a clean base
   * (e.g. `git reset --hard origin/main` after the PR merged): the branch is
   * now identical to the base, so the stale "merged" PR state should be
   * dropped and the session treated as clean with no current PR. A genuinely
   * just-merged branch is NOT at the base tip (it still holds its own commits
   * — for a squash merge the merge commit on the base isn't in the branch's
   * history), so this stays false and the merged card correctly persists until
   * the user resets.
   *
   * Local git only (no network). Fail-safe false (stay merged) on any
   * resolution error or a missing `origin/<base>`. Like
   * {@link advancedBeyondMergedBase} it reads a remote-tracking ref, so the
   * caller must have fetched — against a stale `origin/<base>` this reads a
   * branch reset onto an outdated base tip as "at base".
   */
  async headIsAtBase(baseBranch: string): Promise<boolean> {
    const baseRef = `origin/${baseBranch}`;
    try {
      const baseTip = (await this.git.revparse(["--verify", baseRef])).trim();
      if (!baseTip) return false;
      const head = (await this.git.revparse(["--verify", "HEAD"])).trim();
      return head !== "" && head === baseTip;
    } catch {
      return false; // origin/<base> or HEAD unresolvable — fail safe, stay merged
    }
  }

  /**
   * docs/218 — the current branch name, or `null` when HEAD is detached. Unlike
   * {@link getCurrentBranch} (which falls back to "main" on a null `status.current`,
   * masking a detached HEAD), this reports detachment honestly via
   * `rev-parse --abbrev-ref HEAD` returning the literal "HEAD". Used by the
   * pre-turn auto-reset gate, which must NOT reset a detached HEAD (the reset
   * would not move `session.branch`, making the card's "branch updated" claim
   * false). Fail-safe `null` on any resolution error.
   */
  async currentBranchOrNull(): Promise<string | null> {
    try {
      const ref = (await this.git.revparse(["--abbrev-ref", "HEAD"])).trim();
      return ref && ref !== "HEAD" ? ref : null;
    } catch {
      return null;
    }
  }

  /**
   * docs/218 — true when a merge, cherry-pick, or revert is mid-flight (an
   * in-progress rebase is covered separately by {@link isRebaseInProgress}).
   * Detected by the sentinel files git writes into the git dir. A hard reset
   * during any of these would clobber the recovery state, so the pre-turn
   * auto-reset gate bails when this (or a rebase) is in progress. Fail-safe
   * `false` on a resolution error (the SHA-equality clause is the real guard).
   */
  async isMergeOrSequencerInProgress(): Promise<boolean> {
    try {
      const gitDir = (await this.git.revparse(["--absolute-git-dir"])).trim();
      return (
        fs.existsSync(path.join(gitDir, "MERGE_HEAD")) ||
        fs.existsSync(path.join(gitDir, "CHERRY_PICK_HEAD")) ||
        fs.existsSync(path.join(gitDir, "REVERT_HEAD"))
      );
    } catch {
      return false;
    }
  }

  /**
   * docs/218 — hard-reset the current branch to `origin/<baseBranch>`, discarding
   * the branch's own (already-merged, now-phantom) commits. Returns the before →
   * after HEAD SHAs for the transcript card's audit line. Throws if
   * `origin/<baseBranch>` cannot be resolved — the caller fetches first and treats
   * a throw as "skip the reset, run the turn on the un-moved branch".
   *
   * Caller owns the safety gate (clean tree, `HEAD === mergedHeadSha`, plain repo
   * state); this method just performs the move.
   */
  async resetHardToRemoteBase(baseBranch: string): Promise<{ from: string; to: string }> {
    const baseRef = `origin/${baseBranch}`;
    const from = (await this.git.revparse(["HEAD"])).trim();
    const to = (await this.git.revparse(["--verify", baseRef])).trim();
    if (!to) throw new Error(`Cannot resolve ${baseRef}`);
    await this.git.reset(["--hard", baseRef]);
    console.log(`[git] Reset --hard to ${baseRef} (${from.slice(0, 8)} → ${to.slice(0, 8)})`);
    return { from, to };
  }

  /**
   * Get per-file diff summary (files changed with insertions/deletions),
   * from `--numstat` (see {@link numstatSummary} for why not `--stat`).
   * `binary` is true when git reports `-\t-` in --numstat (the canonical
   * binary signal). It's NOT inferred from `insertions === 0 && deletions === 0`
   * because pure renames, mode-only changes, and empty files also produce 0/0.
   * Returns an empty array if there are no commits or no changes.
   */
  async diffSummary(range?: string): Promise<{ file: string; insertions: number; deletions: number; binary: boolean }[]> {
    try {
      const result = await this.numstatSummary(range ?? "HEAD~1...HEAD");
      return result.files;
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
   * The repo's default branch as this clone understands it — `main`, `master`,
   * `trunk`, whatever the remote's HEAD points at.
   *
   * Read from `refs/remotes/origin/HEAD`, which `git clone` writes at clone time
   * (and which the bare cache propagates to per-session clones), so this costs
   * one local ref read: no network, no credential prompt. Falls back to probing
   * for `origin/main` then `origin/master`, and finally to the literal "main" —
   * the same guess every caller made before this method existed, so the worst
   * case is exactly the old behavior.
   *
   * Exists because "the base branch" was previously hard-coded to "main" in a
   * dozen places (ready-card diff stats, changed-file lists, the diff route),
   * each of which silently produced wrong or empty results on a `master` repo.
   */
  async getDefaultBranch(): Promise<string> {
    try {
      const head = await this.git.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]);
      const match = /refs\/remotes\/[^/]+\/(.+)/.exec(head.trim());
      if (match) return match[1];
    } catch {
      // origin/HEAD not set (older clone, or a repo with no remote) — probe.
    }
    for (const candidate of ["main", "master"]) {
      try {
        await this.git.revparse(["--verify", `origin/${candidate}`]);
        return candidate;
      } catch {
        // try next candidate
      }
    }
    return "main";
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
   * docs/214 — merge `ref` into the current branch while TAKING THE INCOMING TREE
   * WHOLESALE: record a 2-parent merge commit (current tip + `ref`) whose tree is
   * byte-for-byte `ref`'s, fully overriding the current branch's divergence.
   *
   * This is the release `--from` path. A `--from main` release should ship main's
   * tree at the new version while remaining a descendant of `origin/<release-branch>`,
   * so the bump PR still merges into stable with no conflict and history records
   * the release point. Stable may carry cherry-picked hotfixes, but for a full
   * `--from main` release those are forward-ported to main anyway — so the release
   * takes main wholesale and ignores stable's divergence entirely. Because the tree
   * is *replaced* (not three-way merged), this can NEVER conflict, even on real
   * code divergence — which is the whole point: merges never need manual resolution.
   *
   * Built with plumbing rather than `git merge` so it's unconditional (no
   * conflict path, no "already up to date" special-case): synthesize the commit
   * with `commit-tree` (tree = `ref`'s tree, parents = [HEAD, ref]) then move the
   * branch + working tree onto it with `reset --hard`. The first parent is HEAD,
   * keeping the new commit a descendant of the release branch.
   */
  async mergeOverride(ref: string): Promise<void> {
    const headSha = (await this.git.revparse(["HEAD"])).trim();
    const refSha = (await this.git.revparse([ref])).trim();
    const refTree = (await this.git.revparse([`${ref}^{tree}`])).trim();
    const newCommit = (
      await this.git.raw(["commit-tree", refTree, "-p", headSha, "-p", refSha, "-m", `Merge ${ref} (release override)`])
    ).trim();
    await this.git.reset(["--hard", newCommit]);
    console.log("[git] merge-override (took incoming tree):", ref, "→", newCommit);
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
   * Read a blob at a commit as raw bytes (not decoded to UTF-8, which would
   * corrupt binary content like images). Returns `null` when the path doesn't
   * exist at that commit or the blob exceeds `maxBytes` (default 16 MB).
   *
   * Uses `git show` over `execFile` with a Buffer encoding because simple-git's
   * `.show()`/`.raw()` always decode stdout to a string.
   *
   * docs/266-orchestrator-git-trust-boundary E2 — the uid drop has to be spelled out here because this is a raw
   * `execFile`, not the `safeSimpleGit` instance the rest of the class uses.
   * Without it this one method kept running as root in a session workspace.
   */
  async getFileBufferAtCommit(
    commitHash: string,
    filePath: string,
    maxBytes = 16 * 1_048_576,
  ): Promise<Buffer | null> {
    return new Promise((resolve) => {
      execFile(
        "git",
        gitArgsWithHooksDisabled(["show", `${commitHash}:${filePath}`]),
        {
          cwd: this.workspaceDir,
          encoding: "buffer",
          maxBuffer: maxBytes,
          ...gitSpawnOverridesForTree(this.workspaceDir),
        },
        (err, stdout) => {
          if (err || !stdout || stdout.length === 0) resolve(null);
          else resolve(stdout);
        },
      );
    });
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
    await (await this.remoteGit(remote)).fetch(remote);
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
   * docs/266 / planning#407 — {@link isClean}, plus the question `isClean` cannot
   * answer: **could git read the whole tree?**
   *
   * `isClean()` is `true` for content git cannot see, because git cannot see
   * it. Before the uid drop that was a distinction without a difference — root
   * read everything — so every caller that gates a DESTRUCTIVE action on a
   * clean tree was correct by accident. It no longer is: `tier-escalation`'s
   * pre-eviction commit asks "is the work still only in the working tree?" and
   * gets "no" for a subtree the session uid cannot open, then wipes the
   * checkout. That is uncommitted work with no reflog entry and no recovery —
   * the exact loss `CLAUDE.md` invariant 2 names, newly reachable because of
   * the drop. So a caller whose next step destroys the tree must ask THIS
   * question, not `isClean()`.
   *
   * Only the unreadable-DIRECTORY state can hide here. An unreadable FILE is
   * listed by `status` as modified (measured — see {@link AutoCommitResult}),
   * so it already answers `clean: false`; it is `add -A` that then fails, which
   * is `autoCommit`'s half of the same problem.
   */
  async inspectWorkingTree(): Promise<{ clean: boolean; unreadable: UnreadableWorkspace | null }> {
    this.resetStderr();
    const status = await this.git.status();
    const match = UNREADABLE_DIR_RE.exec(this.stderrTail);
    return {
      clean: status.isClean(),
      unreadable: match ? { kind: "omitted", detail: match[1] } : null,
    };
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
      const out = await (await this.remoteGit(remote)).listRemote(["--heads", remote, currentBranch]);
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
    const git = await this.remoteGit(remote);
    // Same duty as the plain push: rewritten history can reference LFS objects
    // the remote has never seen (a rebase onto a base that added assets, a
    // reset onto a fresh base), and no hook will send them.
    await this.uploadLfsObjects(git, remote, branch);
    await git.push(remote, branch, args);
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
   * Force-move a local branch ref to point at `target`, WITHOUT checking it out
   * (`git branch -f <branch> <target>`). Unlike {@link createBranchFrom} (which
   * uses `checkout -B` and switches the working branch), this leaves HEAD and the
   * working tree untouched — the session stays on its own branch.
   *
   * Used by the "Sync with <base>" flow to fast-forward the session clone's local
   * base ref (e.g. `main`) up to `origin/<base>` after a fetch, so the agent's
   * `git diff main...HEAD` / `git log main..HEAD` reference current code rather
   * than the frozen clone-time snapshot (a session clone's default refspec only
   * advances `origin/<base>`, never local `<base>` — see docs/157 / repo-git.ts).
   *
   * `git branch -f` refuses to move the currently-checked-out branch; callers must
   * skip when `branch === getCurrentBranch()` (in practice the session is always on
   * `shipit/<id>`, never on the base).
   */
  async forceUpdateBranchRef(branch: string, target: string): Promise<void> {
    await this.git.raw(["branch", "-f", branch, target]);
    console.log("[git] branch -f", branch, "→", target);
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

  /**
   * docs/214 — count the commits reachable from `head` but not `base`
   * (`git rev-list --count base..head`). The release-prepare guard uses this to
   * detect a content-free release: after the payload (`--pick`/`--from`) is
   * applied but before the version bump, a count of 0 means the bump PR would
   * ship only the version-number change, identical to what `base` already has.
   * Returns 0 when either ref can't be resolved (treated as "nothing new").
   */
  async countCommitsAhead(base: string, head: string): Promise<number> {
    try {
      const out = await this.git.raw(["rev-list", "--count", `${base}..${head}`]);
      const n = Number.parseInt(out.trim(), 10);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }

  /**
   * docs/214 — the text of `filePath` as it exists at `ref` (`git show ref:path`),
   * or null when the ref or path can't be resolved. Used by the release cold-start
   * guard to read `.github/workflows/release.yml` on the maintenance branch and
   * decide whether merging a bump PR there will actually auto-publish.
   */
  async showFileAtRef(ref: string, filePath: string): Promise<string | null> {
    try {
      return await this.git.raw(["show", `${ref}:${filePath}`]);
    } catch {
      return null;
    }
  }

  /** Create an annotated tag at HEAD (or `ref`) and push it to `remote`. */
  async createAndPushTag(tag: string, message: string, remote = "origin", ref?: string): Promise<void> {
    const args = ["tag", "-a", tag, "-m", message, ...(ref ? [ref] : [])];
    await this.git.raw(args);
    await (await this.remoteGit(remote)).push(remote, tag);
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
