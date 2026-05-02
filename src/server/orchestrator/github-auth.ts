import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import type { CredentialStore } from "./credential-store.js";
import { setGitIdentity } from "./git-config.js";
// Sub-module imports — delegated implementations
import { createRepo as createRepoImpl, listUserRepos as listUserReposImpl, searchRepos as searchReposImpl } from "./github-auth-repos.js";
import { createPullRequest as createPullRequestImpl, findPullRequest as findPullRequestImpl, findPullRequestAnyState as findPullRequestAnyStateImpl, mergePullRequest as mergePullRequestImpl, enableAutoMerge as enableAutoMergeImpl, disableAutoMerge as disableAutoMergeImpl } from "./github-auth-prs.js";
import { getCheckStatus as getCheckStatusImpl, getCheckRunAnnotations as getCheckRunAnnotationsImpl, getJobLogs as getJobLogsImpl } from "./github-auth-checks.js";

export interface GitHubAuthStatus {
  authenticated: boolean;
  username?: string;
  avatarUrl?: string;
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
   */
  checkCredentials(): boolean {
    const token = this.credentialStore.getGithubToken();
    if (token) {
      this._token = token;
      return true;
    }
    this._token = null;
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

  /**
   * Return a clone URL with embedded credentials for HTTPS GitHub URLs.
   * Falls back to the original URL if no token or non-GitHub URL.
   */
  getAuthenticatedCloneUrl(repoUrl: string): string {
    if (!this._token) return repoUrl;
    try {
      const u = new URL(repoUrl);
      if (u.hostname === "github.com") {
        u.username = "x-access-token";
        u.password = this._token;
        return u.toString();
      }
    } catch {
      // Not a valid URL — return as-is
    }
    return repoUrl;
  }

  /** Clear stored token, git config, and in-memory state. */
  clearCredentials(): void {
    this._token = null;
    this._username = null;
    this._avatarUrl = null;
    this.credentialStore.clearGithubToken();
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
  ): Promise<{ url: string; number: number; base: string; title: string } | null> {
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
    url: string; number: number; base: string; title: string;
    state: "open" | "closed"; merged_at: string | null;
    additions: number; deletions: number;
  } | null> {
    if (!this._token) return null;
    return findPullRequestAnyStateImpl(this._token, owner, repo, head);
  }

  /**
   * Merge a pull request.
   */
  async mergePullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
    method: "merge" | "squash" | "rebase" = "merge",
  ): Promise<{ success: boolean; message: string }> {
    if (!this._token) return { success: false, message: "Not authenticated" };
    return mergePullRequestImpl(this._token, owner, repo, pullNumber, method);
  }

  /**
   * Enable auto-merge on a pull request.
   * Uses the GraphQL API since REST doesn't support auto-merge.
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
   * Run a GraphQL query against the GitHub API.
   * Returns the parsed JSON response body, or null if not authenticated.
   */
  async graphqlQuery<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T | null> {
    if (!this._token) return null;

    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this._token}`,
        "Content-Type": "application/json",
        "User-Agent": "ShipIt",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) return null;
    return (await res.json()) as T;
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
export { createPullRequest, findPullRequest, findPullRequestAnyState, mergePullRequest, enableAutoMerge, disableAutoMerge } from "./github-auth-prs.js";
export { getCheckStatus, getCheckRunAnnotations, getJobLogs } from "./github-auth-checks.js";
