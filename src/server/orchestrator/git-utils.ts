import crypto from "node:crypto";
import { safeSimpleGit } from "../shared/git-hooks-guard.js";
import {
  type GitRemoteCredentialResolver,
  credentialledGit,
  resolveTreeRemoteCredential,
  sanitizeGitEnv,
} from "../shared/git-remote-credential.js";
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

/**
 * Hash a repo URL to a short 16-char hex string for use as a directory name.
 *
 * Hashed credential-free (docs/262 req 19): the stores now key their rows by
 * the stripped URL, so a caller still holding the credentialed spelling — the
 * claim route takes one straight off the request path — would otherwise
 * address a DIFFERENT bare cache, dep cache and per-repo memory directory than
 * the repo row it just resolved, splitting one repository across two of each.
 *
 * Only a URL carrying userinfo hashes differently than before; a clean URL is
 * unchanged, so no existing cache directory moves that the credential scrub
 * (`startup-tasks.ts`) was not already going to orphan.
 */
export function repoUrlToHash(repoUrl: string): string {
  return crypto.createHash("sha256").update(stripRemoteUrlCredentials(repoUrl)).digest("hex").slice(0, 16);
}

/**
 * Remove any embedded userinfo (`user:password@`) from an HTTP(S) URL so a
 * credentialed remote like `https://x-access-token:<pat>@github.com/o/r.git`
 * is never logged, displayed, persisted, or used as a repo-store key. Auth is
 * injected at git-operation time via the credential helper
 * (`configureGitCredentials`), so the URL itself must stay credential-free.
 *
 * Only strips for `http:`/`https:` — an scp-style SSH remote
 * (`git@github.com:o/r.git`) carries its login in a position `new URL` can't
 * parse anyway, and `ssh://git@host/...`'s `git@` is the SSH user, not a
 * secret. Non-URL inputs are returned trimmed and unchanged.
 */
export function stripUrlCredentials(url: string): string {
  const trimmed = (url ?? "").trim();
  try {
    const u = new URL(trimmed);
    if ((u.protocol === "http:" || u.protocol === "https:") && (u.username || u.password)) {
      u.username = "";
      u.password = "";
      return u.toString();
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

/**
 * The strip used when a remote URL is about to be **persisted** — stored in a
 * row, or written into a git config (docs/262 req 19: "a credential a user
 * happens to type into a repository URL is not kept either").
 *
 * Strictly stronger than {@link stripUrlCredentials}, and deliberately a
 * separate function rather than a change to it: that helper's narrow scope is
 * right for the surfaces it was written for (showing a URL back to its own
 * owner, redaction, the identity key), and widening it there would change
 * every one of them at once. This one is used at the write boundary only.
 *
 * Three shapes, all reachable through `setGitRemote`, which takes whatever the
 * user types — the first was the reported violation, the other two were found
 * by the independent review of that fix:
 *
 *  - **http(s) userinfo** — `https://x-access-token:<pat>@host/o/r.git`.
 *    Removed whole, as `stripUrlCredentials` does.
 *  - **a password in ANY other scheme** — `ssh://git:pw@host/o/r.git`. The
 *    *password* goes; the **username stays**, because for ssh that is the login
 *    identity (`git@`) and not a secret, and dropping it breaks the remote.
 *  - **query and fragment** — `…/o/r.git?access_token=pw`. Dropped wholesale
 *    for any parseable URL. A git remote has no meaningful query or fragment
 *    (the same judgement `sanitizeRemoteUrlForInventory` already makes), and
 *    both are places a token demonstrably shows up.
 *
 * An scp-style remote (`git@github.com:o/r.git`) does not parse as a URL and is
 * returned untouched — its `git@` is an ssh login, and a token pasted in that
 * position cannot be told apart from one. The cross-session display boundary
 * (`sanitizeRemoteUrlForInventory`) still fails closed on that shape.
 */
export function stripRemoteUrlCredentials(url: string): string {
  const trimmed = (url ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed; // scp-style, or too malformed to reason about — see above.
  }
  const isHttp = parsed.protocol === "http:" || parsed.protocol === "https:";
  const carries = Boolean((isHttp && parsed.username) || parsed.password || parsed.search || parsed.hash);
  // Return the ORIGINAL string when there is nothing to remove: `new URL`
  // normalizes (a bare host gains a trailing slash), and a stored URL that
  // silently changes shape is a row key that stops matching itself.
  if (!carries) return trimmed;
  if (isHttp) parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

/**
 * True when persisting `url` would persist a credential — i.e. when
 * {@link stripRemoteUrlCredentials} would change it (docs/262 req 19).
 *
 * Defined as "the strip changes it" rather than as a second parser, so the
 * detector and the remedy can never disagree about what a credential is.
 */
export function hasUrlCredentials(url: string): boolean {
  const trimmed = (url ?? "").trim();
  return stripRemoteUrlCredentials(trimmed) !== trimmed;
}

/**
 * Canonicalize a repo URL for *identity* comparison (a comparison key, NOT a
 * value to persist or clone from): strip credentials, lowercase the scheme and
 * host, and drop a trailing slash and a trailing `.git`. Two URLs that point at
 * the same repo — regardless of embedded credentials, host casing, or `.git`
 * suffix — collapse to the same key. Used to reuse an already-registered repo
 * store entry instead of adding a near-duplicate. Non-URL inputs degrade to a
 * lowercased, trimmed best-effort form.
 */
export function canonicalRepoKey(url: string): string {
  const trimmed = (url ?? "").trim();
  try {
    const u = new URL(trimmed);
    const scheme = u.protocol.toLowerCase();
    const host = u.host.toLowerCase();
    const path = u.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
    return `${scheme}//${host}${path}`;
  } catch {
    return trimmed.toLowerCase().replace(/\/+$/, "").replace(/\.git$/i, "");
  }
}

/** GitHub's own character sets. Anchored on purpose — see {@link repoId}. */
const GITHUB_OWNER = String.raw`[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?`;
const GITHUB_REPO = String.raw`[A-Za-z0-9._-]+`;
// Case-insensitive, because a host name is. The groups already span both cases
// and the identity is lower-cased below, so `i` widens nothing.
const GITHUB_HTTPS_REMOTE = new RegExp(
  String.raw`^https?://github\.com/(${GITHUB_OWNER})/(${GITHUB_REPO}?)/?$`, "i",
);
const GITHUB_SSH_REMOTE = new RegExp(
  String.raw`^(?:ssh://)?git@github\.com[:/](${GITHUB_OWNER})/(${GITHUB_REPO}?)/?$`, "i",
);

/**
 * The identity of a GitHub repository, for an **authorization** decision:
 * `github:<owner>/<repo>`, lower-cased, `null` for anything it cannot parse
 * with certainty. NOT {@link canonicalRepoKey}, which gives three keys for three
 * spellings, so a grant written under one would not exist under another. `http`
 * and stripped userinfo/query/fragment are accepted: neither names a repository.
 */
export function repoId(url: string): string | null {
  const trimmed = stripRemoteUrlCredentials((url ?? "").trim());
  const match = GITHUB_HTTPS_REMOTE.exec(trimmed) ?? GITHUB_SSH_REMOTE.exec(trimmed);
  if (!match) return null;
  // Strip a TERMINAL `.git` only — `my.git.tools` keeps its dots.
  return repoIdFromOwnerRepo(match[1], match[2].replace(/\.git$/i, ""));
}

/**
 * The same identity from an ALREADY-resolved owner and repository — what a
 * create returns — so provenance records where the pull request landed rather
 * than the URL the caller hoped for. Validated, not merely lower-cased: these
 * strings reach an authorization key, and a path-bearing value would forge one.
 */
export function repoIdFromOwnerRepo(owner: string, repo: string): string | null {
  const o = (owner ?? "").trim();
  const r = (repo ?? "").trim();
  if (!new RegExp(String.raw`^${GITHUB_OWNER}$`).test(o)) return null;
  if (!new RegExp(String.raw`^${GITHUB_REPO}$`).test(r)) return null;
  if (r === "." || r === "..") return null;
  return `github:${o.toLowerCase()}/${r.toLowerCase()}`;
}

/** Why `pushToOrigin` returned without pushing anything. */
export type PushSkipReason = "no-origin" | "no-branch";

/**
 * Push the current branch to origin. Returns the branch name on success, or null
 * if there is no origin remote or no current branch.
 *
 * `onSkip` names WHICH of those two conditions applied. It exists because the
 * bare `null` is indistinguishable between them and, on the post-turn auto-push
 * path, was the last fully silent exit left in the module: a commit landed, the
 * push returned null, and nothing on any surface said so. Callers that genuinely
 * do not care (the file-editing fire-and-forget push) simply omit it.
 */
export async function pushToOrigin(
  git: GitManager,
  onSkip?: (reason: PushSkipReason) => void,
): Promise<string | null> {
  const remotes = await git.getRemotes();
  const origin = remotes.find((r) => r.name === "origin");
  if (!origin) {
    onSkip?.("no-origin");
    return null;
  }
  const branch = await git.getCurrentBranch();
  if (!branch) {
    onSkip?.("no-branch");
    return null;
  }
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
  opts?: { skipFetch?: boolean; resolveRemoteCredential?: GitRemoteCredentialResolver },
): Promise<{ resetTarget: string | undefined; fetched: boolean; fetchDurationMs: number; authError: boolean }> {
  const t0 = Date.now();
  // `GIT_TERMINAL_PROMPT=0` makes git fail fast instead of prompting on the
  // controlling terminal; the `timeout.block` plugin kills the child if it
  // stalls (e.g. a credential helper that itself blocks). Both are needed —
  // neither alone covers every "fetch hangs forever" mode.
  //
  // We forward our own `process.env` so the child inherits PATH, HOME, and —
  // critically — `GIT_CONFIG_GLOBAL` / `GIT_EDITOR`, both of which the
  // orchestrator deliberately sets in `initGlobalGitConfig` so all git
  // operations pick up identity from `/credentials/.gitconfig` and never
  // open an interactive editor on `rebase --continue`. simple-git v3 treats
  // those two vars as "unsafe" by default (they could carry user-supplied
  // paths to arbitrary configs/binaries) and refuses to spawn — so we opt in
  // explicitly. The env here is ours, not user-controlled, so the protection
  // is a false positive for this code path.
  const gitOptions = {
    timeout: { block: FETCH_STALL_TIMEOUT_MS },
    unsafe: { allowUnsafeConfigPaths: true, allowUnsafeEditor: true },
  };
  // docs/266-orchestrator-git-trust-boundary E3 (planning#404) — this fetch runs on a SESSION workspace, so
  // under E1 it has dropped to the session's uid and can no longer read the
  // orchestrator's PAT. Without a credential of its own it degrades to an
  // anonymous fetch, which is invisible on a public repo and an auth failure on
  // a private one — a failure this function reports as `authError`, i.e. as a
  // possibly-revoked token. `null` when the drop does not apply (local mode,
  // tests, a root-owned tree), leaving this path byte-for-byte as it was.
  const credential = opts?.skipFetch
    ? null
    : await resolveTreeRemoteCredential(workspaceDir, "origin", opts?.resolveRemoteCredential);
  const sg = credential
    ? credentialledGit(workspaceDir, credential, gitOptions)
    : safeSimpleGit(workspaceDir, gitOptions).env({
      ...sanitizeGitEnv(process.env),
      GIT_TERMINAL_PROMPT: "0",
    });
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
 * Force the local default-branch ref (`main` / `master`) to match
 * `origin/<default>`, so commands the agent runs against the bare branch name
 * — `git log main..HEAD`, `git diff main...HEAD` — line up with what the PR
 * actually contains.
 *
 * Why this is needed: every session clone is cut with `git clone --local` from
 * the bare cache, whose `main` is a *snapshot* that can sit behind the real
 * `origin/main`. The session branch is then created off the freshly-fetched
 * `origin/HEAD` (the genuine tip via `fetchAndResolveDefaultBranch`), but the
 * local `main` ref is left pointing at the stale snapshot. The gap between the
 * two — commits already on `origin/main` but not on the local `main` ref —
 * then shows up in `main..HEAD`. An agent asked to "review the PR I created"
 * runs exactly that kind of comparison and reports those already-merged
 * commits as if they were part of the branch (docs/194). ShipIt's own diff
 * helpers (`diffStatVsBranch`, `resolveBaseBranchRef`) prefer `origin/<branch>`
 * and are unaffected; this only realigns the *local* ref the agent reaches for.
 *
 * Best-effort and non-fatal. It is a pure ref move (`git branch -f`) that never
 * touches the working tree or index, and it refuses to move the checked-out
 * branch — at every call site the session is already on its `shipit/*` branch,
 * so `main`/`master` is never current. A detached HEAD, a missing `origin/*`
 * ref, or any git error just skips the sync.
 */
export async function syncLocalDefaultBranchToOrigin(workspaceDir: string): Promise<void> {
  const sg = safeSimpleGit(workspaceDir);
  // Resolve origin's default branch name (origin/HEAD → main/master), then
  // fall back to probing the common names if the symbolic ref isn't set.
  let branch: string | undefined;
  try {
    const head = (await sg.raw(["symbolic-ref", "refs/remotes/origin/HEAD"])).trim();
    const match = /refs\/remotes\/origin\/(.+)/.exec(head);
    if (match) branch = match[1];
  } catch { /* origin/HEAD not set — fall through to probing */ }
  if (!branch) {
    for (const candidate of ["main", "master"]) {
      try {
        await sg.raw(["rev-parse", "--verify", `origin/${candidate}`]);
        branch = candidate;
        break;
      } catch { /* try next */ }
    }
  }
  if (!branch) return;
  try {
    // Never force-update the branch we're standing on. `git branch -f` rejects
    // it anyway, but skipping avoids a noisy warning — at our call sites HEAD
    // is always a `shipit/*` branch, so this only guards an unexpected state.
    const current = (await sg.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (current === branch) return;
    await sg.raw(["branch", "-f", branch, `origin/${branch}`]);
  } catch (err) {
    console.warn(
      `[git] syncLocalDefaultBranchToOrigin: could not move ${branch} to origin/${branch} ` +
        `for ${workspaceDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
 *   - The workspace clone is read via `safeSimpleGit(workspaceDir)` rather
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
    const cacheHead = (await safeSimpleGit(cacheDir).raw(["rev-parse", "HEAD"])).trim();
    if (!cacheHead) return false;
    const sg = safeSimpleGit(workspaceDir);
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

/**
 * Parse owner/repo from a GitHub remote URL — the ACTION resolver. It must
 * agree with {@link repoId} on where a name ends: this group used to be
 * `[^/.]+`, so a grant on `acme/foo.bar` authorised work on `acme/foo`.
 */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  // Handle HTTPS: https://github.com/owner/repo.git
  const httpsMatch = /github\.com\/([^/]+)\/([^/?#]+)/.exec(url);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2].replace(/\.git$/i, "") };
  // Handle SSH: git@github.com:owner/repo.git
  const sshMatch = /github\.com:([^/]+)\/([^/?#]+)/.exec(url);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2].replace(/\.git$/i, "") };
  return null;
}

/**
 * `github:owner/repo` back to the pair the GitHub API takes — for paths that
 * address a repository the SESSION may no longer point at.
 */
export function ownerRepoFromRepoId(identity: string): { owner: string; repo: string } | null {
  const match = /^github:([^/]+)\/([^/]+)$/.exec((identity ?? "").trim());
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}
