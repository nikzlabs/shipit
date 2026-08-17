import { spawn } from "node:child_process";
import { killChild } from "../shared/kill-child.js";
import { gitArgsWithHooksDisabled } from "../shared/git-hooks-guard.js";
import { gitSpawnOverridesForTree } from "../shared/git-tree-uid.js";

/**
 * Git LFS support for session provisioning (docs/231).
 *
 * ## Why this module exists
 *
 * A repo that tracks assets with Git LFS stores ~130-byte pointer stubs in the
 * git object database; the real bytes live on the LFS server and are pulled in
 * separately. Without the `git-lfs` binary, every LFS-tracked file checks out as
 * its pointer stub — images render broken, audio fails to decode, and nothing
 * anywhere says why. That silent failure is the bug this module closes
 * (nikzlabs/shipit#1729).
 *
 * ## Why the orchestrator installs LFS with `--skip-smudge`
 *
 * Both images now ship `git-lfs`, but they configure it differently:
 *
 * - **Session worker** — `git lfs install --system`: full LFS behaviour, so a
 *   `git checkout` in the terminal smudges real content and the agent's commits
 *   of new assets are cleaned into pointers.
 * - **Orchestrator** — `git lfs install --system --skip-smudge`: the *clean*
 *   filter stays active (load-bearing — `postTurnCommit` runs orchestrator-side,
 *   so without it `git add -A` would commit raw binaries into an LFS repo and
 *   corrupt it), while the *smudge* filter is disabled.
 *
 * Skipping smudge orchestrator-side is deliberate, not an optimization.
 * `RepoGit.cloneFromCache` runs `git clone --local` from the bare cache, whose
 * `origin` at that moment is a **local filesystem path**. With smudge active,
 * git would invoke `git-lfs smudge` per file against an LFS endpoint derived
 * from that path — which is not a valid LFS server — and, because
 * `filter.lfs.required = true`, a smudge failure *fails the checkout*. Turning
 * on LFS naively would therefore break cloning outright, which is strictly worse
 * than the pointer stubs it set out to fix.
 *
 * So content is materialized **explicitly**, once, at the end of provisioning:
 * after the session's `origin` has been reset to the real remote and credentials
 * are in place, {@link materializeLfsContent} runs a single batched
 * `git lfs pull`. That also beats smudge on throughput — one batch transfer
 * instead of a serial per-file download.
 *
 * ## Ordering constraints
 *
 * `materializeLfsContent` must run:
 *  - **after** the final worktree-materializing `git checkout -b` (an earlier
 *    pull would be overwritten by pointers the checkout re-writes),
 *  - **after** `configureGitCredentials` (private repos need the helper), and
 *  - **before** `handWorkspaceBackToWorker`. The original reason was that the
 *    pull wrote files as root, so the chown had to come last. Since docs/266-orchestrator-git-trust-boundary E1
 *    the pull DROPS to the tree's identity, so most of what it writes already
 *    belongs to the session; the ordering still holds because the drop is a
 *    no-op wherever the process is not root (local mode, dev, tests) and because
 *    `git lfs` also writes `.git` metadata the handback is responsible for. Keep
 *    the order — just don't rely on "the pull writes as root", which is no
 *    longer true.
 *
 * ## Provisioning is not the only path that has to do this
 *
 * The same skip-smudge asymmetry applies to every LATER orchestrator-side
 * rewrite of a live session's worktree — the rebase driver, the merged-branch
 * `reset --hard`, the fork-merge. Those run the identical orchestrator git with
 * the identical disabled smudge filter, so they re-write every LFS-tracked path
 * they touch as pointer text, and until nikzlabs/shipit#2349 none of them
 * restored it. {@link restoreLfsAfterTreeRewrite} is the one duty every such
 * path owes; see its docstring.
 */

/** Set `SHIPIT_GIT_LFS=off` to detect-and-warn instead of downloading content. */
const LFS_MODE_ENV = "SHIPIT_GIT_LFS";

/** Ceiling on a single `git lfs pull`; asset-heavy repos are on the claim path. */
const DEFAULT_PULL_TIMEOUT_MS = 300_000;
const PULL_TIMEOUT_ENV = "SHIPIT_GIT_LFS_TIMEOUT_MS";

/** Cheap probes (`git lfs version`, `git grep`) still shouldn't hang forever. */
export const PROBE_TIMEOUT_MS = 15_000;

export type LfsStatus =
  /** No tracked `.gitattributes` declares `filter=lfs` — nothing to do. */
  | "not-an-lfs-repo"
  /** LFS content was pulled into the working tree. */
  | "materialized"
  /** Repo uses LFS but the `git-lfs` binary isn't on PATH. */
  | "binary-missing"
  /** Repo uses LFS but `SHIPIT_GIT_LFS=off` suppressed the download. */
  | "disabled"
  /** Repo uses LFS and the pull failed or timed out — content may be partial. */
  | "failed";

export interface LfsResult {
  status: LfsStatus;
  /** Whether the repo declares LFS filters in a tracked `.gitattributes`. */
  usesLfs: boolean;
  /**
   * Operator/user-facing explanation, present for every status except
   * `not-an-lfs-repo` and `materialized`. Written to be actionable on its own —
   * these surface as a toast, where the reader has no other context.
   */
  warning?: string;
  durationMs?: number;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Spawn git and resolve with the exit code rather than throwing.
 *
 * `git grep` uses exit code 1 for "no match", which is a normal answer, not an
 * error — a throwing wrapper (simple-git's `raw`) would conflate it with a real
 * failure. `GIT_TERMINAL_PROMPT=0` keeps a missing credential from blocking
 * session provisioning on an invisible prompt.
 *
 * docs/266-orchestrator-git-trust-boundary E2 — drops to the tree's owner like every other orchestrator-side
 * git. `cwd` here is a session workspace on both live paths (`repoDeclaresLfs`
 * runs `git grep` in it, `materializeLfsContent` runs `git lfs pull`), so this
 * ran as root against a tree untrusted code can write. It is a no-op on the
 * root-owned trees this is also called with — the bare cache, and
 * `process.cwd()` for the `git lfs version` probe.
 */
export function runGit(args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn("git", gitArgsWithHooksDisabled(args), {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        stdio: ["ignore", "pipe", "pipe"],
        ...gitSpawnOverridesForTree(cwd),
      });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: String(err), timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    // Cap what we buffer: `git lfs pull` emits a progress line per object, and a
    // 3,000-asset repo would otherwise pin megabytes of transfer chatter in the
    // orchestrator's heap purely to build a one-line warning.
    const append = (buf: string, chunk: Buffer) => (buf + chunk.toString()).slice(-8192);
    proc.stdout.on("data", (c: Buffer) => (stdout = append(stdout, c)));
    proc.stderr.on("data", (c: Buffer) => (stderr = append(stderr, c)));
    const timer = setTimeout(() => {
      timedOut = true;
      killChild(proc, "SIGKILL");
    }, timeoutMs);
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(err), timedOut });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

let availabilityProbe: Promise<boolean> | null = null;

/**
 * Whether `git lfs` resolves in this process's environment.
 *
 * Memoized as a promise (not a boolean) so concurrent provisioning paths share
 * one probe. The binary is baked into the image, so it can't appear or vanish
 * mid-process — a permanent cache is correct here.
 */
export function isGitLfsAvailable(): Promise<boolean> {
  // Memoize the PROMISE, not its result: `??=` on an async function's return
  // value is what makes two concurrent provisioning paths share one probe. An
  // `await` here would let a second caller in before the assignment.
  availabilityProbe ??= (async () => (await runGit(["lfs", "version"], process.cwd(), PROBE_TIMEOUT_MS)).code === 0)();
  return availabilityProbe;
}

/** Test seam — clears the memoized `git lfs version` probe. */
export function resetGitLfsAvailabilityCache(): void {
  availabilityProbe = null;
}

/**
 * Does this repo track anything with Git LFS?
 *
 * Detection greps the **committed** `.gitattributes` files for `filter=lfs`
 * rather than asking `git lfs ls-files`, for three reasons: it works without the
 * `git-lfs` binary (so we can still warn when it's missing — the whole point of
 * the `binary-missing` status), it's a single ref-scoped grep instead of a walk
 * of the entire tree, and the same call works against a bare cache and a
 * checked-out workspace alike.
 *
 * The `*.gitattributes` pathspec catches nested declarations too: git pathspec
 * globs match across `/` and `*` matches the empty string, so it covers both
 * `.gitattributes` at the root and `packages/ui/.gitattributes`.
 */
export async function repoDeclaresLfs(dir: string, ref = "HEAD"): Promise<boolean> {
  const res = await runGit(
    ["grep", "--ignore-case", "--fixed-strings", "-l", "-e", "filter=lfs", ref, "--", "*.gitattributes"],
    dir,
    PROBE_TIMEOUT_MS,
  );
  // 0 = matched, 1 = no match, anything else (128: unborn HEAD, bad object) is
  // "can't tell" — answer no, which degrades to today's behaviour rather than
  // firing a spurious warning at every non-repo caller.
  return res.code === 0;
}

function pullTimeoutMs(): number {
  const raw = Number(process.env[PULL_TIMEOUT_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PULL_TIMEOUT_MS;
}

/** `SHIPIT_GIT_LFS=off` — detect and warn, but don't spend the bandwidth. */
function lfsDownloadsDisabled(): boolean {
  return (process.env[LFS_MODE_ENV] ?? "").trim().toLowerCase() === "off";
}

/**
 * Pull Git LFS content into a freshly provisioned session workspace.
 *
 * Best-effort by construction: every failure mode returns a result with a
 * warning instead of throwing, because a repo whose assets didn't download is
 * still a usable session, and a session that fails to provision is not. Callers
 * surface `warning` to the user — the issue this fixes was largely about the
 * *silence*, so a status that isn't `materialized` must never be swallowed.
 *
 * See the module docstring for the ordering constraints on when to call this.
 */
export async function materializeLfsContent(
  workspaceDir: string,
  /**
   * Test seam. `isAvailable` overrides the `git lfs version` probe so the
   * `binary-missing` branch — the exact condition this feature exists to fix —
   * is testable on a machine that *does* have git-lfs installed.
   */
  opts?: { isAvailable?: () => Promise<boolean> },
): Promise<LfsResult> {
  const usesLfs = await repoDeclaresLfs(workspaceDir);
  if (!usesLfs) return { status: "not-an-lfs-repo", usesLfs: false };

  // Checked before the binary probe: when an operator has turned LFS downloads
  // off, "downloads are disabled" is the accurate and actionable message
  // regardless of whether the binary happens to be installed.
  if (lfsDownloadsDisabled()) {
    return {
      status: "disabled",
      usesLfs: true,
      warning:
        "This repository uses Git LFS, but LFS downloads are disabled on this deployment " +
        `(${LFS_MODE_ENV}=off) — LFS-tracked files are pointer stubs, not real content. ` +
        "Run `git lfs pull` in the terminal to fetch them.",
    };
  }

  if (!(await (opts?.isAvailable ?? isGitLfsAvailable)())) {
    return {
      status: "binary-missing",
      usesLfs: true,
      warning:
        "This repository uses Git LFS, but the `git-lfs` binary is not available — " +
        "LFS-tracked files (images, audio, other large assets) are checked out as " +
        "small pointer stubs instead of real content.",
    };
  }

  const startedAt = Date.now();
  const res = await runGit(["lfs", "pull"], workspaceDir, pullTimeoutMs());
  const durationMs = Date.now() - startedAt;

  if (res.code === 0) {
    console.log(`[git-lfs] Pulled LFS content for ${workspaceDir} in ${durationMs}ms`);
    return { status: "materialized", usesLfs: true, durationMs };
  }

  const detail = (res.stderr || res.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 300);
  const reason = res.timedOut
    ? `timed out after ${Math.round(pullTimeoutMs() / 1000)}s`
    : `exited ${res.code ?? "abnormally"}${detail ? `: ${detail}` : ""}`;
  console.warn(`[git-lfs] git lfs pull failed for ${workspaceDir} — ${reason}`);
  return {
    status: "failed",
    usesLfs: true,
    durationMs,
    warning:
      `This repository uses Git LFS and \`git lfs pull\` ${reason}. Some LFS-tracked files ` +
      "may still be pointer stubs rather than real content — re-run `git lfs pull` in the terminal.",
  };
}

/**
 * {@link materializeLfsContent} plus the "never fail silently" half of the
 * contract: any outcome that leaves pointer stubs on disk is reported through
 * `warn` (the provisioning paths pass an SSE broadcast).
 *
 * Every provisioning site calls this rather than the raw function, so the
 * decision of *what counts as worth warning about* lives in exactly one place.
 * Swallows its own errors — LFS is an asset-quality concern, and no failure here
 * may take down session provisioning.
 */
export async function materializeLfsWithWarning(
  workspaceDir: string,
  repoLabel: string,
  warn: (message: string) => void,
  opts?: { isAvailable?: () => Promise<boolean> },
): Promise<LfsResult> {
  let result: LfsResult;
  try {
    result = await materializeLfsContent(workspaceDir, opts);
  } catch (err) {
    console.warn(`[git-lfs] Materialization threw for ${workspaceDir}:`, String(err));
    return { status: "failed", usesLfs: true };
  }
  if (result.warning) warn(`${repoLabel}: ${result.warning}`);
  return result;
}

/**
 * Re-materialize LFS content after the ORCHESTRATOR rewrote an existing
 * session's worktree — a rebase, a `reset --hard`, a merge (nikzlabs/shipit#2349).
 *
 * ## Why every such path needs this
 *
 * Those rewrites run the orchestrator's git, which is installed
 * `--skip-smudge` (see the module docstring — enabling smudge there would break
 * `clone --local` outright). So git re-materializes every file the rewrite
 * touched, and for an LFS-tracked path that means writing back the ~130-byte
 * **pointer stub** the object database holds, not the asset.
 *
 * The reported symptom is exactly what that predicts and is nastier than a
 * missing file: only the paths the rewrite touched go stale, LFS files it did
 * not touch keep their real bytes, git reports the tree **clean** (the pointer
 * in the index never changed), and nothing announces any of it. A dev server
 * then hands 130 bytes of text to an image/font/model decoder, and the failure
 * surfaces as corrupted rendering some distance from the cause.
 *
 * ## What it runs, and why a pull rather than a checkout
 *
 * `git lfs pull` (via {@link materializeLfsContent}), not `git lfs checkout`.
 * A checkout is enough for the reported case — the object was already in
 * `.git/lfs/objects` — but a sync onto a moved base can bring in assets this
 * clone has never seen, and a checkout leaves those as stubs while exiting 0.
 * When every object is already local the pull makes no network call, so the
 * cheap case stays cheap. A repo that doesn't use LFS costs one `git grep`.
 *
 * ## Ordering
 *
 * Call it at a SETTLED tree — after the rebase finishes or is aborted, never
 * between conflict iterations: mid-rebase, a conflicted LFS path is pointer
 * text carrying conflict markers, and smudging it would destroy the very
 * conflict the agent is being asked to resolve. Like the provisioning paths,
 * call it **before** `handWorkspaceBackToWorker` so the chown has the last
 * write.
 *
 * Best-effort, like everything else here: a session whose assets didn't restore
 * is degraded, not broken, so the failure is reported and never thrown.
 * `operation` labels the warning with what rewrote the tree, since the reader
 * gets it as a bare toast or log line.
 *
 * "Never thrown" is stricter here than in {@link materializeLfsWithWarning},
 * which swallows the materialization but still lets the `warn` SINK throw. Call
 * sites put this in a `finally` alongside a rewrite that has ALREADY happened,
 * where a throw would replace the flow's real error with this one — or, on the
 * pre-turn reset, make a completed reset report itself as not-moved. So the sink
 * is guarded too.
 *
 * ## Serialized per workspace
 *
 * Two restores of one clone must never overlap. The rebase driver reaches that
 * state on its auto-resolve timeout — the teardown restores before draining the
 * queue, while the killed flow's own `finally` restores as it unwinds — and
 * `git lfs checkout` writes the working file **in place** (measured against
 * git-lfs 3.3.0: same inode before and after, mode preserved), so two writers
 * can interleave inside one asset rather than one simply losing. Calls for the
 * same directory queue instead; each still sees the tree as it stands when its
 * turn comes, which is why they chain rather than share one result.
 *
 * (That in-place write is also why the ownership ordering matters and a
 * `git checkout` measurement doesn't transfer: `git checkout` unlinks and
 * recreates, so the DIRECTORY's permission governs, while git-lfs needs the
 * FILE. It gets away with a read-only file by chmod'ing around the write, which
 * only its owner may do — so a root-owned file plus a dropped uid is EACCES,
 * and the same-owner `0444` case that succeeds proves nothing about it.)
 */
export async function restoreLfsAfterTreeRewrite(
  workspaceDir: string,
  operation: string,
  warn: (message: string) => void = (message) => console.warn(`[git-lfs] ${message}`),
  opts?: { isAvailable?: () => Promise<boolean> },
): Promise<LfsResult> {
  const run = async (): Promise<LfsResult> => {
    try {
      return await materializeLfsWithWarning(workspaceDir, operation, warn, opts);
    } catch (err) {
      console.warn(`[git-lfs] restore after ${operation} threw for ${workspaceDir}:`, String(err));
      return { status: "failed", usesLfs: true };
    }
  };
  // eslint-disable-next-line no-restricted-syntax -- chaining IS the mechanism: `await` here would let a second caller in before the tail is published
  const chained = (restoreChains.get(workspaceDir) ?? Promise.resolve()).then(run);
  // The chain link must never reject — `run` already can't, but a rejected tail
  // would poison every later call for this directory.
  // eslint-disable-next-line no-restricted-syntax -- Promise two-arg form, to swallow both settlements into a plain marker
  const tail = chained.then(() => undefined, () => undefined);
  restoreChains.set(workspaceDir, tail);
  try {
    return await chained;
  } finally {
    // Drop the entry only when nothing queued behind us, so the map doesn't grow
    // one permanent promise per session workspace for the process's lifetime.
    if (restoreChains.get(workspaceDir) === tail) restoreChains.delete(workspaceDir);
  }
}

/** Tail of the in-flight {@link restoreLfsAfterTreeRewrite} chain, per workspace. */
const restoreChains = new Map<string, Promise<void>>();
