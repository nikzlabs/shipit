import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import type { CredentialStore } from "./credential-store.js";
import { setGitIdentity } from "./git-config.js";

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

    try {
      const res = await fetch("https://api.github.com/user/repos", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this._token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "ShipIt",
        },
        body: JSON.stringify({
          name,
          description: options.description || "",
          private: options.isPrivate ?? true,
          auto_init: false,
        }),
      });

      if (!res.ok) {
        const err = (await res.json()) as { message?: string };
        return {
          success: false,
          message: err.message || `GitHub API returned ${res.status}`,
        };
      }

      const data = (await res.json()) as {
        name: string;
        full_name: string;
        html_url: string;
        clone_url: string;
      };
      return {
        success: true,
        name: data.name,
        fullName: data.full_name,
        url: data.html_url,
        cloneUrl: data.clone_url,
      };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
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

    try {
      const res = await fetch(
        `https://api.github.com/repos/${options.owner}/${options.repo}/pulls`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this._token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "ShipIt",
          },
          body: JSON.stringify({
            title: options.title,
            body: options.body,
            head: options.head,
            base: options.base,
            draft: options.draft ?? false,
          }),
        },
      );

      if (!res.ok) {
        const err = (await res.json()) as { message?: string };
        return { success: false, message: err.message || `GitHub API returned ${res.status}` };
      }

      const data = (await res.json()) as { html_url: string; number: number };
      return {
        success: true,
        url: data.html_url,
        number: data.number,
      };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * List the authenticated user's repos, sorted by most recently pushed.
   * Used to populate the repo selector before the user types a search query.
   */
  async listUserRepos(): Promise<Array<{
    fullName: string;
    description: string | null;
    private: boolean;
    defaultBranch: string;
    cloneUrl: string;
  }>> {
    if (!this._token) return [];

    try {
      const res = await fetch(
        "https://api.github.com/user/repos?sort=pushed&per_page=15&affiliation=owner,collaborator",
        {
          headers: {
            Authorization: `Bearer ${this._token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "ShipIt",
          },
        },
      );

      if (!res.ok) return [];

      const data = (await res.json()) as Array<{ full_name: string; description: string | null; private: boolean; default_branch: string; clone_url: string }>;
      return data.map((r) => ({
        fullName: r.full_name,
        description: r.description,
        private: r.private,
        defaultBranch: r.default_branch,
        cloneUrl: r.clone_url,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Search the user's accessible repos by name.
   */
  async searchRepos(query: string): Promise<Array<{
    fullName: string;
    description: string | null;
    private: boolean;
    defaultBranch: string;
    cloneUrl: string;
  }>> {
    if (!this._token) return [];

    const res = await fetch(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}+in:name&sort=updated&per_page=10`,
      {
        headers: {
          Authorization: `Bearer ${this._token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "ShipIt",
        },
      },
    );

    if (!res.ok) return [];

    const data = (await res.json()) as { items: Array<{ full_name: string; description: string | null; private: boolean; default_branch: string; clone_url: string }> };
    return data.items.map((r) => ({
      fullName: r.full_name,
      description: r.description,
      private: r.private,
      defaultBranch: r.default_branch,
      cloneUrl: r.clone_url,
    }));
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

    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${head}&state=open`,
      {
        headers: {
          Authorization: `Bearer ${this._token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "ShipIt",
        },
      },
    );

    if (!res.ok) return null;
    const prs = (await res.json()) as Array<{ html_url: string; number: number; base: { ref: string }; title: string }>;
    if (prs.length === 0) return null;

    const pr = prs[0];
    return {
      url: pr.html_url,
      number: pr.number,
      base: pr.base.ref,
      title: pr.title,
    };
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

    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${head}&state=all&sort=updated&direction=desc&per_page=1`,
      {
        headers: {
          Authorization: `Bearer ${this._token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "ShipIt",
        },
      },
    );

    if (!res.ok) return null;
    const prs = (await res.json()) as Array<{
      html_url: string; number: number; base: { ref: string }; title: string;
      state: "open" | "closed"; merged_at: string | null;
      additions: number; deletions: number;
    }>;
    if (prs.length === 0) return null;

    const pr = prs[0];
    return {
      url: pr.html_url,
      number: pr.number,
      base: pr.base.ref,
      title: pr.title,
      state: pr.state,
      merged_at: pr.merged_at,
      additions: pr.additions,
      deletions: pr.deletions,
    };
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

    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/merge`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this._token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "ShipIt",
        },
        body: JSON.stringify({ merge_method: method }),
      },
    );

    if (!res.ok) {
      const err = (await res.json()) as { message?: string };
      if (res.status === 405) {
        return { success: false, message: err.message || "PR is not mergeable" };
      }
      return { success: false, message: err.message || `GitHub API returned ${res.status}` };
    }

    return { success: true, message: "Pull request merged" };
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

    // First, get the PR's node ID (needed for GraphQL)
    const prRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`,
      {
        headers: {
          Authorization: `Bearer ${this._token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "ShipIt",
        },
      },
    );

    if (!prRes.ok) return { success: false, message: "Failed to fetch PR details" };
    const prData = (await prRes.json()) as { node_id: string };
    const nodeId = prData.node_id;

    // Enable auto-merge via GraphQL
    const graphqlRes = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this._token}`,
        "Content-Type": "application/json",
        "User-Agent": "ShipIt",
      },
      body: JSON.stringify({
        query: `mutation EnableAutoMerge($prId: ID!, $method: PullRequestMergeMethod!) {
          enablePullRequestAutoMerge(input: { pullRequestId: $prId, mergeMethod: $method }) {
            pullRequest { autoMergeRequest { enabledAt } }
          }
        }`,
        variables: { prId: nodeId, method },
      }),
    });

    if (!graphqlRes.ok) return { success: false, message: "Failed to enable auto-merge" };
    const graphqlData = (await graphqlRes.json()) as { errors?: Array<{ message: string }> };

    if (graphqlData.errors) {
      const errMsg = graphqlData.errors[0]?.message ?? "Unknown error";
      if (errMsg.includes("auto-merge")) {
        return { success: false, message: "Auto-merge is not enabled for this repository. Enable it in repo Settings > General." };
      }
      return { success: false, message: errMsg };
    }

    return { success: true, message: "Auto-merge enabled — PR will merge when checks pass" };
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

    // Get the PR's node ID
    const prRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`,
      {
        headers: {
          Authorization: `Bearer ${this._token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "ShipIt",
        },
      },
    );

    if (!prRes.ok) return { success: false, message: "Failed to fetch PR details" };
    const prData = (await prRes.json()) as { node_id: string };
    const nodeId = prData.node_id;

    const graphqlRes = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this._token}`,
        "Content-Type": "application/json",
        "User-Agent": "ShipIt",
      },
      body: JSON.stringify({
        query: `mutation DisableAutoMerge($prId: ID!) {
          disablePullRequestAutoMerge(input: { pullRequestId: $prId }) {
            pullRequest { autoMergeRequest { enabledAt } }
          }
        }`,
        variables: { prId: nodeId },
      }),
    });

    if (!graphqlRes.ok) return { success: false, message: "Failed to disable auto-merge" };
    const graphqlData = (await graphqlRes.json()) as { errors?: Array<{ message: string }> };

    if (graphqlData.errors) {
      return { success: false, message: graphqlData.errors[0]?.message ?? "Unknown error" };
    }

    return { success: true, message: "Auto-merge disabled" };
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

    let passed = 0, failed = 0, pending = 0;

    // Get combined status (legacy status API)
    try {
      const statusRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/commits/${ref}/status`,
        {
          headers: {
            Authorization: `Bearer ${this._token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "ShipIt",
          },
        },
      );

      if (statusRes.ok) {
        const statusData = (await statusRes.json()) as { statuses: Array<{ state: string }> };
        for (const s of statusData.statuses) {
          if (s.state === "success") passed++;
          else if (s.state === "failure" || s.state === "error") failed++;
          else pending++;
        }
      }
    } catch {
      // ignore
    }

    // Also get check runs (GitHub Actions uses this API)
    try {
      const checksRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/commits/${ref}/check-runs`,
        {
          headers: {
            Authorization: `Bearer ${this._token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "ShipIt",
          },
        },
      );

      if (checksRes.ok) {
        const checksData = (await checksRes.json()) as { check_runs: Array<{ conclusion: string | null; status: string }> };
        for (const check of checksData.check_runs) {
          if (check.conclusion === "success") passed++;
          else if (check.conclusion === "failure" || check.conclusion === "cancelled" || check.conclusion === "timed_out") failed++;
          else if (check.status !== "completed") pending++;
        }
      }
    } catch {
      // ignore
    }

    const total = passed + failed + pending;
    const state = total === 0 ? "none" as const : failed > 0 ? "failure" as const : pending > 0 ? "pending" as const : "success" as const;

    return { state, total, passed, failed, pending };
  }

  /**
   * Get check run annotations (structured failure details with file paths and line numbers).
   * Returns empty array if not authenticated or if the API call fails.
   */
  async getCheckRunAnnotations(
    owner: string,
    repo: string,
    checkRunId: number,
  ): Promise<Array<{
    path: string;
    startLine: number;
    endLine: number;
    message: string;
    annotationLevel: "failure" | "warning" | "notice";
  }>> {
    if (!this._token) return [];

    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/check-runs/${checkRunId}/annotations`,
        {
          headers: {
            Authorization: `Bearer ${this._token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "ShipIt",
          },
        },
      );

      if (!res.ok) return [];

      const data = (await res.json()) as Array<{
        path: string;
        start_line: number;
        end_line: number;
        message: string;
        annotation_level: string;
      }>;
      return data.map((a) => ({
        path: a.path,
        startLine: a.start_line,
        endLine: a.end_line,
        message: a.message,
        annotationLevel: a.annotation_level as "failure" | "warning" | "notice",
      }));
    } catch {
      return [];
    }
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

    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`,
        {
          headers: {
            Authorization: `Bearer ${this._token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "ShipIt",
          },
          redirect: "follow",
        },
      );

      if (!res.ok) return "";

      const text = await res.text();
      // Return last 100 lines to keep prompt size reasonable
      const lines = text.split("\n");
      return lines.slice(-100).join("\n");
    } catch {
      return "";
    }
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
