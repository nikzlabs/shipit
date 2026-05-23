import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import type { CredentialStore } from "./credential-store.js";
import { setGitIdentity, setGlobalCredentialHelper, clearGlobalCredentialHelper } from "./git-config.js";
// Sub-module imports — delegated implementations
import { createRepo as createRepoImpl, listUserRepos as listUserReposImpl, searchRepos as searchReposImpl } from "./github-auth-repos.js";
import { createPullRequest as createPullRequestImpl, findPullRequest as findPullRequestImpl, findPullRequestAnyState as findPullRequestAnyStateImpl, mergePullRequest as mergePullRequestImpl, enableAutoMerge as enableAutoMergeImpl, disableAutoMerge as disableAutoMergeImpl, updatePullRequest as updatePullRequestImpl, addPullRequestComment as addPullRequestCommentImpl, markPullRequestReady as markPullRequestReadyImpl, listPullRequests as listPullRequestsImpl, viewPullRequest as viewPullRequestImpl } from "./github-auth-prs.js";
import { getCheckStatus as getCheckStatusImpl, getCheckRunAnnotations as getCheckRunAnnotationsImpl, getJobLogs as getJobLogsImpl } from "./github-auth-checks.js";
import { addReviewThreadReply as addReviewThreadReplyImpl, resolveReviewThread as resolveReviewThreadImpl, unresolveReviewThread as unresolveReviewThreadImpl } from "./github-auth-review-threads.js";

export interface GitHubAuthStatus {
  authenticated: boolean;
  username?: string;
  avatarUrl?: string;
}

/**
 * Snapshot of GitHub API rate-limit state. Updated after every GraphQL call.
 * The poller reads this to decide whether to skip its next tick; the UI
 * surfaces a banner with a countdown to `resetAt` so users understand why
 * status updates have paused.
 *
 * `limited` flips to true on 403/429 responses, on `retry-after` headers,
 * and on 200 responses that carry `errors[].type === "RATE_LIMITED"` or
 * `"SECONDARY_RATE_LIMITED"`. It flips back to false on the next successful
 * call after `resetAt`, or immediately when a clean 200 lands.
 */
export interface GitHubRateLimitState {
  limited: boolean;
  /** Epoch ms when the limit is expected to clear, or `null` if unknown. */
  resetAt: number | null;
  /** Remaining points in the current window, or `null` if unknown. */
  remaining: number | null;
}

export interface GitHubRepoResult {
  success: boolean;
  name?: string;
  fullName?: string;
  url?: string;
  cloneUrl?: string;
  message?: string;
}

/**
 * Validates a GitHub PAT by calling the GitHub API.
 * Returns user info on success, null on failure.
 */
export async function validateGitHubToken(
  token: string,
): Promise<{ username: string; avatarUrl: string; id: number; displayName: string | null } | null> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "ShipIt",
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { login: string; avatar_url: string; id: number; name: string | null };
    return { username: data.login, avatarUrl: data.avatar_url, id: data.id, displayName: data.name };
  } catch {
    return null;
  }
}

export class GitHubAuthManager extends EventEmitter {
  private _token: string | null = null;
  private _username: string | null = null;
  private _avatarUrl: string | null = null;
  private credentialStore: CredentialStore;
  private workspaceDir: string;
  private _rateLimit: GitHubRateLimitState = {
    limited: false,
    resetAt: null,
    remaining: null,
  };

  constructor(workspaceDir: string, credentialStore: CredentialStore) {
    super();
    this.workspaceDir = workspaceDir;
    this.credentialStore = credentialStore;
  }

  get authenticated(): boolean {
    return this._token !== null;
  }

  /**
   * Check if a token file exists and load it into memory.
   * Returns true if credentials were found.
   *
   * Resolution order:
   *   1. `CredentialStore` (disk file). This is the persisted token written
   *      when the user goes through the OAuth flow in the UI.
   *   2. `process.env.GITHUB_TOKEN`. Used in dogfooding (ShipIt-in-ShipIt
   *      local mode), where the outer orchestrator forwards its own token
   *      to the inner orchestrator via `x-shipit-secrets` —
   *      `platform:github_token`. The inner container has no `/credentials`
   *      mount, so env is the only path.
   *
   * Env-sourced tokens are NOT persisted back to disk: env is the source of
   * truth in local mode and the outer's token rotation should be picked up
   * on the next `checkCredentials()` rather than masked by a stale on-disk
   * copy.
   */
  checkCredentials(): boolean {
    const diskToken = this.credentialStore.getGithubToken();
    if (diskToken) {
      this._token = diskToken;
      // Rewrite the global credential helper on every boot. The orchestrator
      // process may have started before any session was active, so this is
      // the only place that guarantees the global helper matches the stored
      // token after a restart (or after a token-rotate that crashed mid-write).
      try { setGlobalCredentialHelper(diskToken); } catch (err) {
        console.error("[github-auth] Failed to install global credential helper on boot:", err);
      }
      return true;
    }
    const envToken = process.env.GITHUB_TOKEN?.trim();
    if (envToken) {
      this._token = envToken;
      try { setGlobalCredentialHelper(envToken); } catch (err) {
        console.error("[github-auth] Failed to install global credential helper on boot (env token):", err);
      }
      return true;
    }
    this._token = null;
    // No token — make sure the global helper isn't left over from a previous
    // boot. Otherwise stale credentials silently authenticate git operations
    // until they're rejected by the remote.
    try { clearGlobalCredentialHelper(); } catch { /* nothing to clear */ }
    return false;
  }

  /**
   * Validate and store a GitHub PAT. Configures git credentials on success.
   * Emits "auth_complete" on success, "auth_failed" on failure.
   */
  async setToken(token: string): Promise<boolean> {
    const trimmed = token.trim();
    if (!trimmed) {
      this.emit("auth_failed", "Token cannot be empty");
      return false;
    }

    const userInfo = await validateGitHubToken(trimmed);
    if (!userInfo) {
      this.emit("auth_failed", "Invalid GitHub token");
      return false;
    }

    this._token = trimmed;
    this._username = userInfo.username;
    this._avatarUrl = userInfo.avatarUrl;

    // Persist token
    this.credentialStore.setGithubToken(trimmed);

    // Install the credential helper *globally* so every workspace
    // (orchestrator-side and every session container — both inherit
    // `GIT_CONFIG_GLOBAL=/credentials/.gitconfig`) picks up the new token
    // without needing a per-workspace backfill. The legacy per-session
    // backfill in `setGitHubToken` still runs as defense-in-depth, but
    // this is the line that fixes warm sessions created while the token
    // was temporarily cleared — those don't appear in `list()` and so
    // were never backfilled before.
    try { setGlobalCredentialHelper(trimmed); } catch (err) {
      console.error("[github-auth] Failed to install global credential helper:", err);
    }

    // Set global git identity from GitHub profile
    this.setGitIdentityFromGitHub(userInfo);

    this.emit("auth_complete");
    return true;
  }

  /** Set global git identity from GitHub user info. */
  private setGitIdentityFromGitHub(info: { username: string; displayName: string | null; id: number }): void {
    const gitName = info.displayName ?? info.username;
    const gitEmail = `${info.id}+${info.username}@users.noreply.github.com`;
    setGitIdentity(gitName, gitEmail);
  }

  /** Get current authentication status. */
  getStatus(): GitHubAuthStatus {
    return {
      authenticated: this._token !== null,
      username: this._username ?? undefined,
      avatarUrl: this._avatarUrl ?? undefined,
    };
  }

  /**
   * Get the raw GitHub PAT for forwarding into compose services. Used by the
   * platform credential provider for `source: platform:github_token`. Most
   * callers should prefer task-specific helpers (e.g. `createPullRequest`)
   * that use the token internally — this getter exists only for the secrets
   * pipeline. Returns `null` if no token is configured.
   */
  getToken(): string | null {
    return this._token;
  }

  /**
   * Configure git credential helper and user identity in a workspace repo
   * so that push/pull work with the stored token.
   * @param targetDir - Optional directory to configure. Defaults to the instance's workspaceDir.
   */
  configureGitCredentials(targetDir?: string): void {
    if (!this._token) return;

    const cwd = targetDir ?? this.workspaceDir;
    try {
      const opts = { cwd, stdio: "pipe" as const };
      // Use a credential helper that returns the token as the password.
      // The helper is a shell one-liner that echoes the token.
      execSync(
        `git config credential.helper '!f() { echo "password=${this._token}"; echo "username=x-access-token"; }; f'`,
        opts,
      );
      // User identity is inherited from global git config (set by setToken/loadUserInfo).
    } catch (err) {
      console.error("[github-auth] Failed to configure git credentials:", err);
    }
  }

  /** Clear stored token, git config, and in-memory state. */
  clearCredentials(): void {
    this._token = null;
    this._username = null;
    this._avatarUrl = null;
    this.credentialStore.clearGithubToken();
    // Drop the global credential helper too — otherwise the file at
    // `/credentials/.gitconfig` keeps echoing the now-revoked token to
    // every git operation in every workspace until a fresh token arrives.
    try { clearGlobalCredentialHelper(); } catch (err) {
      console.error("[github-auth] Failed to clear global credential helper:", err);
    }
  }

  /**
   * Mark the current token as invalid — the orchestrator just got a
   * "Authentication failed" / "Invalid username or token" back from a git
   * push, fetch, or pull. Verifies the token against `GET /user` first:
   * if the token is still globally valid, the failure is repo-specific
   * (e.g. a fine-grained PAT whose scope doesn't include this repo) and
   * the stored token is preserved. Only when the verification call also
   * fails do we clear credentials and emit `token_invalid` so the SSE
   * layer (wired in `app-lifecycle.ts`) can push the new auth state to
   * every connected client and surface a toast. Returns `false`
   * (without emitting) when no token is currently stored — that path
   * keeps the call idempotent if multiple git operations fail at once.
   *
   * The verification step is what stops a single per-repo 401 from
   * dropping a working token: the original PR #506 cleared on the first
   * git auth error, which (combined with the over-broad `isGitAuthError`
   * match before that was tightened) wiped freshly-added tokens whenever
   * a stale workspace clone couldn't authenticate.
   *
   * Calling this is preferable to plain `clearCredentials()` because it
   * gives the UI a reason string ("auto-push failed: …") to display, and
   * because the SSE broadcast is gated on the event — without it the
   * client would have to poll `/api/bootstrap` to discover the auth state
   * changed.
   */
  async markTokenInvalid(reason: string): Promise<boolean> {
    const token = this._token;
    if (!token) return false;
    // Verify the token against the GitHub API. A successful `GET /user`
    // proves the token is still valid for the authenticated user even if
    // a per-repo git operation just failed — most often a fine-grained
    // PAT whose repository scope doesn't include the failing repo.
    // Preserve the token in that case.
    const userInfo = await validateGitHubToken(token);
    if (userInfo) {
      console.warn(
        `[github-auth] Git auth error (${reason}) — but token is still valid for ${userInfo.username}; ` +
          `treating as repo-specific (e.g. fine-grained PAT scope), not clearing credentials`,
      );
      return false;
    }
    console.warn(`[github-auth] GitHub token invalidated (${reason}) — clearing credentials and notifying clients`);
    this.clearCredentials();
    this.emit("token_invalid", { reason });
    return true;
  }

  /**
   * Create a new GitHub repository via the API.
   * Returns repo details on success, error message on failure.
   */
  async createRepo(
    name: string,
    options: { description?: string; isPrivate?: boolean } = {},
  ): Promise<GitHubRepoResult> {
    if (!this._token) {
      return { success: false, message: "Not authenticated with GitHub" };
    }
    return createRepoImpl(this._token, name, options);
  }

  /**
   * Create a pull request on GitHub.
   * Returns the PR URL on success, or an error message.
   */
  async createPullRequest(options: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    head: string;
    base: string;
    draft?: boolean;
  }): Promise<{ success: boolean; url?: string; number?: number; message?: string }> {
    if (!this._token) {
      return { success: false, message: "Not authenticated with GitHub" };
    }
    return createPullRequestImpl(this._token, options);
  }

  /**
   * List the authenticated user's repos, sorted by most recently pushed.
   * Used to populate the repo selector before the user types a search query.
   */
  async listUserRepos(): Promise<{
    fullName: string;
    description: string | null;
    private: boolean;
    defaultBranch: string;
    cloneUrl: string;
  }[]> {
    if (!this._token) return [];
    return listUserReposImpl(this._token);
  }

  /**
   * Search the user's accessible repos by name.
   */
  async searchRepos(query: string): Promise<{
    fullName: string;
    description: string | null;
    private: boolean;
    defaultBranch: string;
    cloneUrl: string;
  }[]> {
    if (!this._token) return [];
    return searchReposImpl(this._token, query);
  }

  /**
   * Check if an open PR exists for the given head branch.
   * Returns PR metadata if found, null otherwise.
   */
  async findPullRequest(
    owner: string,
    repo: string,
    head: string,
  ): Promise<{ url: string; number: number; base: string; title: string; body: string } | null> {
    if (!this._token) return null;
    return findPullRequestImpl(this._token, owner, repo, head);
  }

  /**
   * Check if a PR exists for the given head branch in any state (open, closed, merged).
   * Used as a one-time catch-up probe after server restart to detect already-merged PRs.
   */
  async findPullRequestAnyState(
    owner: string,
    repo: string,
    head: string,
  ): Promise<{
    url: string; number: number; base: string; title: string; body: string;
    state: "open" | "closed"; merged_at: string | null;
    additions: number; deletions: number;
  } | null> {
    if (!this._token) return null;
    return findPullRequestAnyStateImpl(this._token, owner, repo, head);
  }

  /**
   * Merge a pull request.
   *
   * Fetches the PR's title and body and forwards them as commit_title /
   * commit_message so the squash/merge commit uses the PR's title and
   * description rather than the repo's "Default commit message" setting
   * (which on older repos concatenates every original commit message). If the
   * PR-detail fetch fails, falls through to the merge with no commit_title
   * override — preserves the previous behavior as a safety net.
   */
  async mergePullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
    method: "merge" | "squash" | "rebase" = "merge",
  ): Promise<{ success: boolean; message: string }> {
    if (!this._token) return { success: false, message: "Not authenticated" };
    const pr = await viewPullRequestImpl(this._token, owner, repo, pullNumber);
    return mergePullRequestImpl(
      this._token,
      owner,
      repo,
      pullNumber,
      method,
      pr?.title,
      pr?.body,
    );
  }

  /**
   * Enable auto-merge on a pull request.
   * Uses the GraphQL API since REST doesn't support auto-merge.
   *
   * The impl fetches the PR's title/body and forwards them as
   * commitHeadline/commitBody — see `enableAutoMerge` in github-auth-prs.ts.
   */
  async enableAutoMerge(
    owner: string,
    repo: string,
    pullNumber: number,
    method: "MERGE" | "SQUASH" | "REBASE" = "MERGE",
  ): Promise<{ success: boolean; message: string }> {
    if (!this._token) return { success: false, message: "Not authenticated" };
    return enableAutoMergeImpl(this._token, owner, repo, pullNumber, method);
  }

  /**
   * Disable auto-merge on a pull request.
   * Uses the GraphQL API (`disablePullRequestAutoMerge` mutation).
   */
  async disableAutoMerge(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<{ success: boolean; message: string }> {
    if (!this._token) return { success: false, message: "Not authenticated" };
    return disableAutoMergeImpl(this._token, owner, repo, pullNumber);
  }

  /**
   * Update an existing pull request (title, body, or state).
   */
  async updatePullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
    options: { title?: string; body?: string; state?: "open" | "closed" },
  ): Promise<{ success: boolean; url?: string; number?: number; message?: string }> {
    if (!this._token) return { success: false, message: "Not authenticated with GitHub" };
    return updatePullRequestImpl(this._token, owner, repo, pullNumber, options);
  }

  /**
   * Add a comment to a pull request (issue-style comment).
   */
  async addPullRequestComment(
    owner: string,
    repo: string,
    pullNumber: number,
    body: string,
  ): Promise<{ success: boolean; url?: string; message?: string }> {
    if (!this._token) return { success: false, message: "Not authenticated with GitHub" };
    return addPullRequestCommentImpl(this._token, owner, repo, pullNumber, body);
  }

  /**
   * Mark a draft pull request as ready for review.
   */
  async markPullRequestReady(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<{ success: boolean; message: string }> {
    if (!this._token) return { success: false, message: "Not authenticated" };
    return markPullRequestReadyImpl(this._token, owner, repo, pullNumber);
  }

  /**
   * List pull requests for a repository.
   */
  async listPullRequests(
    owner: string,
    repo: string,
    state: "open" | "closed" | "all" = "open",
  ): Promise<{ url: string; number: number; base: string; head: string; title: string; state: "open" | "closed"; isDraft: boolean }[]> {
    if (!this._token) return [];
    return listPullRequestsImpl(this._token, owner, repo, state);
  }

  /**
   * Fetch a single PR's details by number.
   */
  async viewPullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<{
    url: string; number: number; base: string; head: string;
    title: string; body: string;
    state: "open" | "closed"; isDraft: boolean; merged: boolean;
    additions: number; deletions: number;
  } | null> {
    if (!this._token) return null;
    return viewPullRequestImpl(this._token, owner, repo, pullNumber);
  }

  /**
   * Get CI check status for a PR's head commit.
   */
  async getCheckStatus(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<{ state: "pending" | "success" | "failure" | "none"; total: number; passed: number; failed: number; pending: number }> {
    if (!this._token) return { state: "none", total: 0, passed: 0, failed: 0, pending: 0 };
    return getCheckStatusImpl(this._token, owner, repo, ref);
  }

  /**
   * Get check run annotations (structured failure details with file paths and line numbers).
   * Returns empty array if not authenticated or if the API call fails.
   */
  async getCheckRunAnnotations(
    owner: string,
    repo: string,
    checkRunId: number,
  ): Promise<{
    path: string;
    startLine: number;
    endLine: number;
    message: string;
    annotationLevel: "failure" | "warning" | "notice";
  }[]> {
    if (!this._token) return [];
    return getCheckRunAnnotationsImpl(this._token, owner, repo, checkRunId);
  }

  /**
   * Get raw job logs for a check run (fallback when annotations aren't available).
   * Returns the last 100 lines of the log, or empty string on failure.
   * Note: the check run databaseId maps to the job ID for GitHub Actions.
   */
  async getJobLogs(
    owner: string,
    repo: string,
    jobId: number,
  ): Promise<string> {
    if (!this._token) return "";
    return getJobLogsImpl(this._token, owner, repo, jobId);
  }

  /**
   * Reply to an existing PR review thread (docs/102). `threadId` is the
   * GraphQL node id of the thread (as surfaced on `PrReviewThread.id`).
   */
  async addReviewThreadReply(
    threadId: string,
    body: string,
  ): Promise<{ success: boolean; message: string }> {
    if (!this._token) return { success: false, message: "Not authenticated with GitHub" };
    return addReviewThreadReplyImpl(this._token, threadId, body);
  }

  /** Mark a PR review thread as resolved (docs/102). */
  async resolveReviewThread(threadId: string): Promise<{ success: boolean; message: string }> {
    if (!this._token) return { success: false, message: "Not authenticated with GitHub" };
    return resolveReviewThreadImpl(this._token, threadId);
  }

  /** Reopen (unresolve) a previously-resolved review thread (docs/102). */
  async unresolveReviewThread(threadId: string): Promise<{ success: boolean; message: string }> {
    if (!this._token) return { success: false, message: "Not authenticated with GitHub" };
    return unresolveReviewThreadImpl(this._token, threadId);
  }

  /** Snapshot of the most recent rate-limit state seen on the GraphQL API. */
  getRateLimitState(): GitHubRateLimitState {
    return { ...this._rateLimit };
  }

  /**
   * Run a GraphQL query against the GitHub API.
   * Returns the parsed JSON response body, or null if not authenticated.
   *
   * Rate-limit awareness: parses `x-ratelimit-*` and `retry-after` headers on
   * every response and updates `_rateLimit`. Treats both transport-level
   * rate limiting (HTTP 403/429) and GraphQL-level rate limiting (200 OK
   * with `errors[].type === "RATE_LIMITED" | "SECONDARY_RATE_LIMITED"`) as
   * failure and returns `null`. Without the body-level check, GitHub's
   * common 200 OK + `{"data":{"repository":{"pullRequests":{"nodes":[]}}}}`
   * + RATE_LIMITED errors response would look identical to "no PRs," which
   * (in the poller's case) wrongly promotes every tracked session to merged.
   *
   * Permanently logs non-2xx and 200-with-errors at `warn` so prod logs
   * surface this class of failure without per-incident instrumentation.
   */
  async graphqlQuery<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T | null> {
    if (!this._token) return null;

    let res: Response;
    try {
      res = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this._token}`,
          "Content-Type": "application/json",
          "User-Agent": "ShipIt",
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      console.warn("[github-auth] graphqlQuery network error:", err instanceof Error ? err.message : err);
      return null;
    }

    const requestId = res.headers.get("x-github-request-id") ?? undefined;
    const remainingHeader = res.headers.get("x-ratelimit-remaining");
    const resetHeader = res.headers.get("x-ratelimit-reset");
    const retryAfterHeader = res.headers.get("retry-after");

    const remaining = remainingHeader !== null ? Number.parseInt(remainingHeader, 10) : null;
    // `x-ratelimit-reset` is a UNIX timestamp in seconds; convert to ms.
    const resetFromHeader = resetHeader !== null ? Number.parseInt(resetHeader, 10) * 1000 : null;
    // `retry-after` is either seconds-from-now or an HTTP date; we only
    // honor the seconds form (what GitHub actually sends for the abuse
    // limit) and skip the date case rather than carrying a tiny RFC1123
    // parser.
    const retryAfterMs = retryAfterHeader !== null && /^\d+$/.test(retryAfterHeader)
      ? Number.parseInt(retryAfterHeader, 10) * 1000
      : null;

    const updatePrev = this._rateLimit;
    const updateState = (next: GitHubRateLimitState): void => {
      this._rateLimit = next;
      if (next.limited !== updatePrev.limited || next.resetAt !== updatePrev.resetAt) {
        this.emit("rate_limit_changed", { ...next });
      }
    };

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const truncated = text.length > 500 ? `${text.slice(0, 500)}…` : text;
      console.warn(
        `[github-auth] graphqlQuery non-2xx: status=${res.status} remaining=${remaining ?? "?"} ` +
        `reset=${resetFromHeader ?? "?"} retryAfter=${retryAfterMs ?? "?"} requestId=${requestId ?? "?"} body=${truncated}`,
      );
      // 403 is GitHub's abuse-limit signal; 429 is the formal rate-limit.
      if (res.status === 403 || res.status === 429) {
        const resetAt = retryAfterMs !== null ? Date.now() + retryAfterMs : resetFromHeader;
        updateState({ limited: true, resetAt, remaining });
      } else {
        // Other non-2xx responses don't speak to the rate-limit state; only
        // refresh the remaining/reset trackers if the headers were present.
        if (remaining !== null || resetFromHeader !== null) {
          updateState({ limited: this._rateLimit.limited, resetAt: this._rateLimit.resetAt, remaining });
        }
      }
      return null;
    }

    const body = await res.json().catch(() => null) as { data?: unknown; errors?: { type?: string; code?: string; message?: string }[] } | null;
    if (!body) {
      console.warn("[github-auth] graphqlQuery: 2xx with unparseable JSON");
      return null;
    }

    const errors = body.errors ?? [];
    // GitHub's GraphQL rate-limit errors come in several shapes — the primary
    // budget produces `{type:"RATE_LIMIT", code:"graphql_rate_limit"}` (singular,
    // confusingly), while abuse detection produces `RATE_LIMITED` /
    // `SECONDARY_RATE_LIMITED`. Match all of them, and fall back to the `code`
    // field as a belt-and-braces signal in case GitHub introduces yet another
    // type label.
    const rateLimited = errors.some((e) =>
      e.type === "RATE_LIMIT" ||
      e.type === "RATE_LIMITED" ||
      e.type === "SECONDARY_RATE_LIMITED" ||
      e.code === "graphql_rate_limit",
    );
    if (rateLimited) {
      console.warn(
        `[github-auth] graphqlQuery RATE_LIMITED: remaining=${remaining ?? "?"} reset=${resetFromHeader ?? "?"} ` +
        `requestId=${requestId ?? "?"} errors=${JSON.stringify(errors)}`,
      );
      updateState({ limited: true, resetAt: resetFromHeader, remaining: remaining ?? 0 });
      return null;
    }

    if (errors.length > 0) {
      // Non-rate-limit GraphQL errors — log so prod can see what's failing
      // without flipping rate-limit state.
      console.warn(
        `[github-auth] graphqlQuery 200 with errors: requestId=${requestId ?? "?"} errors=${JSON.stringify(errors)}`,
      );
    }

    // Clean response — clear any prior rate-limit state and refresh trackers.
    updateState({ limited: false, resetAt: null, remaining });
    return body as T;
  }

  /**
   * Load cached user info from GitHub API using stored token.
   * Called on startup when checkCredentials() finds a token file.
   */
  async loadUserInfo(): Promise<void> {
    if (!this._token) return;
    const info = await validateGitHubToken(this._token);
    if (info) {
      this._username = info.username;
      this._avatarUrl = info.avatarUrl;
      // Restore global git identity from GitHub profile
      this.setGitIdentityFromGitHub(info);
    } else {
      // Token is invalid — clear it
      this.clearCredentials();
    }
  }
}

// Barrel re-exports from sub-modules for backwards compatibility
export { createRepo, listUserRepos, searchRepos } from "./github-auth-repos.js";
export { createPullRequest, findPullRequest, findPullRequestAnyState, mergePullRequest, enableAutoMerge, disableAutoMerge, updatePullRequest, addPullRequestComment, markPullRequestReady, listPullRequests, viewPullRequest } from "./github-auth-prs.js";
export { getCheckStatus, getCheckRunAnnotations, getJobLogs } from "./github-auth-checks.js";
export { addReviewThreadReply, resolveReviewThread, unresolveReviewThread } from "./github-auth-review-threads.js";
