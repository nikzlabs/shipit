import { spawn } from "node:child_process";
import { killChild } from "../shared/kill-child.js";
import { gitArgsWithHooksDisabled } from "../shared/git-hooks-guard.js";
import { gitSpawnOverridesForTree } from "../shared/git-tree-uid.js";
import { lfsDeclarationGrepArgs } from "../shared/git-lfs-push.js";
import {
  type GitRemoteCredential,
  type GitRemoteCredentialResolver,
  gitCredentialSpawnOverrides,
  looksLikeAuthRejection,
  resolveTreeRemoteCredential,
  sanitizeGitEnv,
  withPreemptiveAuthFallback,
} from "../shared/git-remote-credential.js";

// Orchestrator smudge is disabled: clone --local initially points at the bare cache.
// Pull after the final checkout and credential setup, before ownership handback.
const LFS_MODE_ENV = "SHIPIT_GIT_LFS";
const DEFAULT_PULL_TIMEOUT_MS = 300_000;
const PULL_TIMEOUT_ENV = "SHIPIT_GIT_LFS_TIMEOUT_MS";
export const PROBE_TIMEOUT_MS = 15_000;

export type LfsStatus =
  | "not-an-lfs-repo"
  | "materialized"
  | "binary-missing"
  | "disabled"
  | "failed";

export type LfsFailure = "no-credential" | "access-denied" | "timeout" | "other";

export interface LfsResult {
  status: LfsStatus;
  usesLfs: boolean;
  failure?: LfsFailure;
  warning?: string;
  durationMs?: number;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runGit(
  args: string[],
  cwd: string,
  timeoutMs: number,
  // Replaces process.env so callers can remove inherited credential overrides.
  env?: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn("git", gitArgsWithHooksDisabled(args), {
        cwd,
        env: { ...(env ?? process.env), GIT_TERMINAL_PROMPT: "0" },
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

// Registered once so every provisioning and rewrite path receives credentials.
let lfsRemoteCredentialResolver: GitRemoteCredentialResolver | undefined;

export function configureLfsRemoteCredentialResolver(
  resolve: GitRemoteCredentialResolver | undefined,
): void {
  lfsRemoteCredentialResolver = resolve;
}

let availabilityProbe: Promise<boolean> | null = null;

export function isGitLfsAvailable(): Promise<boolean> {
  // Publish the promise before awaiting so concurrent calls share one probe.
  availabilityProbe ??= (async () => (await runGit(["lfs", "version"], process.cwd(), PROBE_TIMEOUT_MS)).code === 0)();
  return availabilityProbe;
}

export function resetGitLfsAvailabilityCache(): void {
  availabilityProbe = null;
}

// Committed attributes can be checked without git-lfs, including in bare repos.
export async function repoDeclaresLfs(dir: string, ref = "HEAD"): Promise<boolean> {
  const res = await runGit(lfsDeclarationGrepArgs(ref), dir, PROBE_TIMEOUT_MS);
  return res.code === 0;
}

export function classifyPullFailure(output: string): LfsFailure {
  if (/could not read Username|could not read Password|terminal prompts disabled|credentials for .* not found/i.test(output)) {
    return "no-credential";
  }
  if (/\b401\b|\b403\b|Authentication failed|Access denied|repository not found|does not exist/i.test(output)) {
    return "access-denied";
  }
  return "other";
}

function failureAdvice(failure: LfsFailure): string {
  const stubs = "Some LFS-tracked files may still be pointer stubs rather than real content";
  switch (failure) {
    case "no-credential":
      return `${stubs}. ShipIt could not present a credential to the LFS endpoint — `
        + "reconnect GitHub in Settings, then re-run `git lfs pull` in the terminal.";
    case "access-denied":
      return `${stubs}. The LFS server refused the credential ShipIt presented — `
        + "the connected GitHub account may not have access to this repository's LFS storage.";
    default:
      return `${stubs} — re-run \`git lfs pull\` in the terminal.`;
  }
}

function pullTimeoutMs(): number {
  const raw = Number(process.env[PULL_TIMEOUT_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PULL_TIMEOUT_MS;
}

function lfsDownloadsDisabled(): boolean {
  return (process.env[LFS_MODE_ENV] ?? "").trim().toLowerCase() === "off";
}

export interface LfsOpts {
  isAvailable?: () => Promise<boolean>;
  resolveCredential?: () => Promise<GitRemoteCredential | null>;
  // Overrides the pull only; detection and availability probes remain real.
  spawnGit?: typeof runGit;
}

export async function materializeLfsContent(
  workspaceDir: string,
  opts?: LfsOpts,
): Promise<LfsResult> {
  const usesLfs = await repoDeclaresLfs(workspaceDir);
  if (!usesLfs) return { status: "not-an-lfs-repo", usesLfs: false };

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

  const credential = opts?.resolveCredential === undefined
    ? await resolveTreeRemoteCredential(workspaceDir, "origin", lfsRemoteCredentialResolver)
    : await opts.resolveCredential();

  const startedAt = Date.now();
  const res = await withPreemptiveAuthFallback(credential, "LFS pull", (usedCredential) => {
    const cred = gitCredentialSpawnOverrides(usedCredential);
    return (opts?.spawnGit ?? runGit)(
      [...cred.args, "lfs", "pull"],
      workspaceDir,
      pullTimeoutMs(),
      usedCredential ? { ...sanitizeGitEnv(process.env), ...cred.env } : undefined,
    );
  }, (r) => r.code !== 0 && looksLikeAuthRejection(r.stderr || r.stdout));
  const durationMs = Date.now() - startedAt;

  if (res.code === 0) {
    console.log(`[git-lfs] Pulled LFS content for ${workspaceDir} in ${durationMs}ms`);
    return { status: "materialized", usesLfs: true, durationMs };
  }

  const output = res.stderr || res.stdout;
  const detail = output.trim().split("\n").slice(-3).join(" ").slice(0, 300);
  const reason = res.timedOut
    ? `timed out after ${Math.round(pullTimeoutMs() / 1000)}s`
    : `exited ${res.code ?? "abnormally"}${detail ? `: ${detail}` : ""}`;
  const failure = res.timedOut ? "timeout" : classifyPullFailure(output);
  console.warn(`[git-lfs] git lfs pull failed for ${workspaceDir} — ${reason}`);
  return {
    status: "failed",
    usesLfs: true,
    durationMs,
    failure,
    warning:
      `This repository uses Git LFS and \`git lfs pull\` ${reason}. ${failureAdvice(failure)}`,
  };
}

export async function materializeLfsWithWarning(
  workspaceDir: string,
  repoLabel: string,
  warn: (message: string) => void,
  opts?: LfsOpts,
): Promise<LfsResult> {
  let result: LfsResult;
  try {
    result = await materializeLfsContent(workspaceDir, opts);
  } catch (err) {
    console.warn(`[git-lfs] Materialization threw for ${workspaceDir}:`, String(err));
    return { status: "failed", usesLfs: true, failure: "other" };
  }
  if (result.warning) warn(`${repoLabel}: ${result.warning}`);
  return result;
}

export function buildLfsUnresolvedAgentNotice(result: LfsResult): string {
  const because = (() => {
    switch (result.status) {
      case "disabled":
        return `LFS downloads are disabled on this deployment (${LFS_MODE_ENV}=off)`;
      case "binary-missing":
        return "the `git-lfs` binary is not available to ShipIt's provisioning";
      default:
        switch (result.failure) {
          case "no-credential":
            return "ShipIt could not present a credential to the LFS endpoint";
          case "access-denied":
            return "the LFS server refused the credential ShipIt presented";
          case "timeout":
            return "the pull exceeded its time limit";
          default:
            return "the pull failed";
        }
    }
  })();
  return (
    "[System] This workspace's Git LFS content did not finish resolving during setup, because "
    + `${because}. LFS-tracked files (images, audio, models, other large assets) may therefore `
    + "hold a ~130-byte pointer stub instead of their real content. A stub still looks like the "
    + "file and git reports the tree as clean, so a build, a test, or a read of one of these "
    + "assets will see plausible wrong data rather than a missing file. Before relying on any "
    + "large asset, check it with `head -c 120 <path>` — a stub starts with "
    + "`version https://git-lfs.github.com/spec/v1`. Run `git lfs pull` in the terminal to fetch "
    + "the real content, and report it if that fails too."
  );
}

// Restore only after the rewrite settles, before ownership handback.
// Pull also fetches newly introduced assets; checkout alone leaves missing objects as stubs.
export async function restoreLfsAfterTreeRewrite(
  workspaceDir: string,
  operation: string,
  warn: (message: string) => void = (message) => console.warn(`[git-lfs] ${message}`),
  opts?: LfsOpts,
): Promise<LfsResult> {
  const run = async (): Promise<LfsResult> => {
    try {
      return await materializeLfsWithWarning(workspaceDir, operation, warn, opts);
    } catch (err) {
      console.warn(`[git-lfs] restore after ${operation} threw for ${workspaceDir}:`, String(err));
      return { status: "failed", usesLfs: true };
    }
  };
  // LFS writes in place, so overlapping restores can corrupt an asset.
  // eslint-disable-next-line no-restricted-syntax -- publish the tail before awaiting
  const chained = (restoreChains.get(workspaceDir) ?? Promise.resolve()).then(run);
  // eslint-disable-next-line no-restricted-syntax -- settle both outcomes so failures cannot poison the queue
  const tail = chained.then(() => undefined, () => undefined);
  restoreChains.set(workspaceDir, tail);
  try {
    return await chained;
  } finally {
    if (restoreChains.get(workspaceDir) === tail) restoreChains.delete(workspaceDir);
  }
}

const restoreChains = new Map<string, Promise<void>>();
