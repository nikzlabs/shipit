import crypto from "node:crypto";
import simpleGit from "simple-git";
import type { GitManager } from "../shared/git.js";

/** Generate a short random branch suffix for the "shipit/" namespace. */
export function generateBranchSlug(): string {
  // 4.5 bytes → 6 base64url chars (no padding). Used as a uniqueness suffix
  // so branch names read as shipit/<descriptive-name>-<random>.
  return crypto.randomBytes(6).toString("base64url").toLowerCase().slice(0, 6);
}

/** Generate a branch name in the "shipit/" namespace with only the random slug. */
export function generateBranchPrefix(): string {
  return `shipit/${  generateBranchSlug()}`;
}

/** Hash a repo URL to a short 16-char hex string for use as a directory name. */
export function repoUrlToHash(repoUrl: string): string {
  return crypto.createHash("sha256").update(repoUrl).digest("hex").slice(0, 16);
}

/**
 * Push the current branch to origin. Returns the branch name on success, or null
 * if there is no origin remote or no current branch.
 */
export async function pushToOrigin(git: GitManager): Promise<string | null> {
  const remotes = await git.getRemotes();
  const origin = remotes.find((r) => r.name === "origin");
  if (!origin) return null;
  const branch = await git.getCurrentBranch();
  if (!branch) return null;
  await git.push("origin", branch);
  return branch;
}

/**
 * Fetch `origin` in a session/workspace clone and resolve the current
 * default-branch ref.
 *
 * The warm pool and the claim slow-path build each session clone with
 * `git clone --local` from the bare cache — a *snapshot* that can be
 * hundreds of commits behind the real remote if the bare cache itself
 * hasn't fetched (stale embedded token, etc.). Resolving `origin/main`
 * inside that snapshot — or against the stale bare cache — silently
 * provisions the session, and its container's memory limit, from an
 * outdated `shipit.yaml`.
 *
 * This helper fetches the *real* remote in the workspace clone so
 * `origin/HEAD` / `origin/main` / `origin/master` resolve to the genuine
 * latest commit. Shared by the warm path, the claim slow-path, and
 * `refreshCloneToLatestMain` so all three resolve "latest main" the same
 * way and cannot drift.
 *
 * Credentials must already be configured in `workspaceDir` for private
 * repos — callers run `configureGitCredentials` first.
 *
 * The fetch is best-effort and bounded: when the remote is unreachable
 * (offline, rotated token, a non-fetchable URL in tests) the error is
 * swallowed and resolution falls back to whatever `origin/*` refs the
 * local clone already has — i.e. it degrades to "branch from the
 * snapshot", the pre-W2 behavior, rather than failing the warm/claim path
 * outright. `GIT_TERMINAL_PROMPT=0` plus a stall timeout guarantee the
 * fetch can never block on an interactive credential prompt — important
 * because this runs on the per-repo-serialized claim slow-path, where a
 * hang would wedge every claim for that repo.
 *
 * @returns the resolved ref (a SHA from `origin/HEAD`, or the
 *   `origin/main` / `origin/master` ref name), or `undefined` if none
 *   resolved; `fetched` is whether the network fetch actually succeeded;
 *   plus the fetch duration for telemetry.
 */
/**
 * Kill the `git fetch` child if it produces no output for this long — a
 * credential prompt or a dead remote stalls silently, so a stall is our
 * only signal. Progress output (on stderr) resets the timer, so a slow
 * but live fetch of a large repo is not affected.
 */
const FETCH_STALL_TIMEOUT_MS = 30_000;

export async function fetchAndResolveDefaultBranch(
  workspaceDir: string,
): Promise<{ resetTarget: string | undefined; fetched: boolean; fetchDurationMs: number }> {
  const t0 = Date.now();
  // `GIT_TERMINAL_PROMPT=0` makes git fail fast instead of prompting on the
  // controlling terminal; the `timeout.block` plugin kills the child if it
  // stalls (e.g. a credential helper that itself blocks). Both are needed —
  // neither alone covers every "fetch hangs forever" mode.
  const sg = simpleGit(workspaceDir, { timeout: { block: FETCH_STALL_TIMEOUT_MS } })
    .env({ ...process.env, GIT_TERMINAL_PROMPT: "0" });
  let fetched = false;
  try {
    await sg.fetch("origin");
    fetched = true;
  } catch (err) {
    // Remote unreachable / timed out — fall through to local-ref resolution.
    console.warn(
      `[git] fetchAndResolveDefaultBranch: origin fetch failed for ${workspaceDir} ` +
        `(resolving from local refs instead): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Try origin/HEAD first, then fall back to common default branch names.
  // Avoid `git remote set-head --auto` — it hits the network and can hang
  // if credentials aren't configured in this clone yet.
  let resetTarget: string | undefined;
  try {
    resetTarget = (await sg.raw(["rev-parse", "origin/HEAD"])).trim();
  } catch {
    for (const branch of ["origin/main", "origin/master"]) {
      try {
        resetTarget = (await sg.raw(["rev-parse", branch])).trim();
        break;
      } catch { /* try next */ }
    }
  }
  return { resetTarget, fetched, fetchDurationMs: Date.now() - t0 };
}

/** Parse owner/repo from a GitHub remote URL. */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  // Handle HTTPS: https://github.com/owner/repo.git
  const httpsMatch = /github\.com\/([^/]+)\/([^/.]+)/.exec(url);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  // Handle SSH: git@github.com:owner/repo.git
  const sshMatch = /github\.com:([^/]+)\/([^/.]+)/.exec(url);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
  return null;
}
