import { spawn } from "node:child_process";

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
 *  - **before** `handWorkspaceBackToWorker` (the pull writes files as root, so
 *    the chown has to come last or the agent can't edit them).
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
 */
export function runGit(args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn("git", args, {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        stdio: ["ignore", "pipe", "pipe"],
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
      proc.kill("SIGKILL");
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
