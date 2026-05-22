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
 * Kill the `git fetch` child if it produces no output for this long — a
 * credential prompt or a dead remote stalls silently, so a stall is our
 * only signal. Progress output (on stderr) resets the timer, so a slow
 * but live fetch of a large repo is not affected.
 */
const FETCH_STALL_TIMEOUT_MS = 30_000;

/**
 * Check if a git operation failed because the remote *rejected* the
 * supplied credential (expired / revoked / wrong). GitHub (and other
 * HTTPS remotes) surface this on stderr from `git push`, `git fetch`,
 * and `git pull` with one of a handful of well-known strings — match
 * all of them so we catch the failure regardless of which command emitted it.
 *
 * IMPORTANT: this matches *remote rejection* only. It deliberately does
 * NOT match "could not read Username" / "terminal prompts disabled" —
 * those signal a *client-side configuration* problem (no credential
 * helper, or the helper returned nothing), and a valid stored token
 * must not be invalidated when the local repo simply isn't wired up to
 * use it. The fix for that path is to (re-)configure credentials and
 * retry, not to drop the user's token. See `configureGitCredentials`
 * and the reuse path in `refreshCloneToLatestMain`.
 *
 * Centralizing the detection lets the orchestrator surface a "your GitHub
 * token is invalid — please re-authenticate" signal to the UI rather
 * than swallowing the error in server logs, which is the W3 problem
 * reported on `fetchAndResolveDefaultBranch`. See `GitHubAuthManager.markTokenInvalid`.
 */
export function isGitAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("Authentication failed") ||
    msg.includes("Invalid username or token") ||
    msg.includes("Password authentication is not supported") ||
    msg.includes("Bad credentials") ||
    msg.includes("401 Unauthorized") ||
    /\b(403|401)\b.*(Forbidden|Unauthorized)/i.test(msg)
  );
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
 * @param onAuthError — called when the fetch failure is recognized as a
 *   credential error (expired/revoked token). Useful so callers can mark
 *   the stored GitHub token invalid; not used for any other failure
 *   mode. See `isGitAuthError`.
 *
 * @param opts.skipFetch — when `true`, skip the network fetch entirely and
 *   resolve `resetTarget` from whatever `origin/*` refs the clone already
 *   has. The claim slow-path passes this when the bare cache was just
 *   pre-fetched in the background (docs/145): the freshly-cloned workspace's
 *   local `origin/HEAD` already reflects the latest commit, so the round-trip
 *   is pure overhead. `fetched` is reported `false` (no network happened) but
 *   this is a *deliberate* skip, not a failure — callers that pass `skipFetch`
 *   must not surface a stale-clone warning on the strength of `!fetched`.
 *
 * @returns the resolved ref (a SHA from `origin/HEAD`, or the
 *   `origin/main` / `origin/master` ref name), or `undefined` if none
 *   resolved; `fetched` is whether the network fetch actually succeeded;
 *   `authError` is `true` when the fetch failure was an auth error
 *   (token expired/revoked), `false` otherwise — including when the
 *   fetch succeeded; plus the fetch duration for telemetry.
 */
export async function fetchAndResolveDefaultBranch(
  workspaceDir: string,
  // Returns `unknown` so callers can pass either a sync `() => void` or an
  // async `() => Promise<void>` (e.g. `markTokenInvalid`, which verifies the
  // token against `GET /user` before clearing). The fire-and-forget call
  // below intentionally does not await the result — the fetch path doesn't
  // need to block on credential invalidation.
  onAuthError?: (err: Error) => unknown,
  opts?: { skipFetch?: boolean },
): Promise<{ resetTarget: string | undefined; fetched: boolean; fetchDurationMs: number; authError: boolean }> {
  const t0 = Date.now();
  // `GIT_TERMINAL_PROMPT=0` makes git fail fast instead of prompting on the
  // controlling terminal; the `timeout.block` plugin kills the child if it
  // stalls (e.g. a credential helper that itself blocks). Both are needed —
  // neither alone covers every "fetch hangs forever" mode.
  const sg = simpleGit(workspaceDir, { timeout: { block: FETCH_STALL_TIMEOUT_MS } })
    .env({ ...process.env, GIT_TERMINAL_PROMPT: "0" });
  let fetched = false;
  let authError = false;
  try {
    if (opts?.skipFetch) {
      // Deliberate skip — the bare cache was pre-fetched in the background,
      // so the clone's local refs are already current (docs/145).
    } else {
      await sg.fetch("origin");
      fetched = true;
    }
  } catch (err) {
    // Remote unreachable / timed out — fall through to local-ref resolution.
    console.warn(
      `[git] fetchAndResolveDefaultBranch: origin fetch failed for ${workspaceDir} ` +
        `(resolving from local refs instead): ${err instanceof Error ? err.message : String(err)}`,
    );
    if (isGitAuthError(err)) {
      authError = true;
      // Surface the credential failure to the caller so it can mark the
      // GitHub token as invalid — otherwise the next push/fetch fails
      // the same silent way and the user never learns their token
      // expired. See `GitHubAuthManager.markTokenInvalid`.
      onAuthError?.(err instanceof Error ? err : new Error(String(err)));
    }
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
  return { resetTarget, fetched, fetchDurationMs: Date.now() - t0, authError };
}

/**
 * Cheap local agreement check: does the workspace clone's `origin/HEAD`
 * (or `origin/main` / `origin/master`) point to the same commit as the
 * bare cache's HEAD?
 *
 * This is the gate that pairs with `RepoPrefetcher.coveredRecently()` on
 * the claim path. `coveredRecently` only proves the *bare cache* was
 * fetched in the background recently — it says nothing about a warm
 * session clone whose `origin/*` refs were frozen at warm time. A warm
 * session that sat idle in the pool for hours/days/months has a stale
 * `origin/HEAD` even while the prefetcher keeps the cache advancing.
 * Skipping the claim-time fetch on the strength of `coveredRecently`
 * alone then branches the new session from that frozen snapshot — the
 * regression behind the 2-month-stale claim observed on 2026-05-22.
 *
 * Both reads are local `rev-parse` invocations (sub-millisecond on a
 * warm filesystem), so the docs/145 win is preserved for the common
 * "recently warmed pool" case. Only a long-idle warm clone trips the
 * mismatch and falls back to `refreshCloneToLatestMain`.
 *
 * Defaults to `false` (i.e. "not in sync — do the refresh") on any
 * error: a missing cache, an unresolvable ref, or a half-built clone
 * should all degrade to the correct (slower) full-refresh path, not
 * to a silent skip.
 *
 * Notes:
 *   - The bare cache's `HEAD` is a symbolic ref to its default branch
 *     (set by `git clone --bare`), so `rev-parse HEAD` in the cache
 *     dir is exactly "the commit the prefetcher last advanced `main`
 *     to" — the same commit a fresh `--local` clone would see as its
 *     `origin/HEAD`.
 *   - The workspace clone is read via `simpleGit(workspaceDir)` rather
 *     than through `RepoGit`, since `RepoGit` models the bare-cache
 *     side. We try `origin/HEAD` first (`cloneFromCache` preserves it)
 *     and fall back to `origin/main` / `origin/master` for older
 *     clones that may not have an `origin/HEAD` symbolic ref.
 */
export async function isWorkspaceCloneInSyncWithCache(
  workspaceDir: string,
  cacheDir: string,
): Promise<boolean> {
  try {
    const cacheHead = (await simpleGit(cacheDir).raw(["rev-parse", "HEAD"])).trim();
    if (!cacheHead) return false;
    const sg = simpleGit(workspaceDir);
    for (const ref of ["origin/HEAD", "origin/main", "origin/master"]) {
      try {
        const cloneHead = (await sg.raw(["rev-parse", ref])).trim();
        if (cloneHead) return cloneHead === cacheHead;
      } catch { /* try next ref */ }
    }
    return false;
  } catch {
    return false;
  }
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
