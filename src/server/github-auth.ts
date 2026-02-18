import { EventEmitter } from "node:events";
import fs from "node:fs";
import { execSync } from "node:child_process";

const DEFAULT_TOKEN_PATH = "/workspace/.github-token";

// TODO: Replace with a ShipIt-owned GitHub OAuth App client ID once registered.
// Client IDs are public (not secrets), so hardcoding here is fine.
// The env var allows self-hosted deployments to use their own OAuth App.
const GITHUB_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID;

export interface GitHubAuthStatus {
  authenticated: boolean;
  username?: string;
  avatarUrl?: string;
  /** Whether the GitHub device auth flow is available (client ID configured). */
  deviceAuthAvailable: boolean;
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
): Promise<{ username: string; avatarUrl: string } | null> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "ShipIt",
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { login: string; avatar_url: string };
    return { username: data.login, avatarUrl: data.avatar_url };
  } catch {
    return null;
  }
}

export class GitHubAuthManager extends EventEmitter {
  private _token: string | null = null;
  private _username: string | null = null;
  private _avatarUrl: string | null = null;
  private tokenPath: string;
  private workspaceDir: string;

  constructor(workspaceDir?: string, tokenPath?: string) {
    super();
    this.workspaceDir = workspaceDir ?? "/workspace";
    this.tokenPath = tokenPath ?? DEFAULT_TOKEN_PATH;
  }

  get authenticated(): boolean {
    return this._token !== null;
  }

  /**
   * Check if a token file exists and load it into memory.
   * Returns true if credentials were found.
   */
  checkCredentials(): boolean {
    try {
      if (fs.existsSync(this.tokenPath)) {
        this._token = fs.readFileSync(this.tokenPath, "utf-8").trim();
        if (!this._token) {
          this._token = null;
          return false;
        }
        return true;
      }
    } catch {
      // ignore
    }
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

    // Persist token to disk
    try {
      fs.writeFileSync(this.tokenPath, trimmed, { mode: 0o600 });
    } catch (err) {
      console.error("[github-auth] Failed to persist token:", err);
    }

    // Configure git to use the token
    this.configureGitCredentials();

    this.emit("auth_complete");
    return true;
  }

  /** Get current authentication status. */
  getStatus(): GitHubAuthStatus {
    return {
      authenticated: this._token !== null,
      username: this._username ?? undefined,
      avatarUrl: this._avatarUrl ?? undefined,
      deviceAuthAvailable: !!GITHUB_CLIENT_ID,
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

      // Set user identity from GitHub if available
      if (this._username) {
        execSync(`git config user.name "${this._username}"`, opts);
      }
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

  /** Start the GitHub device authorization flow. Returns code for user to enter. */
  async startDeviceAuth(): Promise<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresIn: number;
    interval: number;
  }> {
    if (!GITHUB_CLIENT_ID) {
      throw new Error("GitHub OAuth is not configured. Set the GITHUB_OAUTH_CLIENT_ID environment variable.");
    }

    const res = await fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        scope: "repo read:user",
      }),
    });

    if (!res.ok) throw new Error(`GitHub device code request failed: ${res.status}`);
    const data = (await res.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    };

    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      expiresIn: data.expires_in,
      interval: data.interval,
    };
  }

  /** Poll for the device auth token. Returns token on success, null if still pending. */
  async pollDeviceAuth(deviceCode: string): Promise<
    | { status: "success"; token: string }
    | { status: "pending" }
    | { status: "expired" }
    | { status: "error"; message: string }
  > {
    if (!GITHUB_CLIENT_ID) {
      return { status: "error", message: "GitHub OAuth is not configured" };
    }

    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    if (!res.ok) return { status: "error", message: `GitHub API returned ${res.status}` };
    const data = (await res.json()) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };

    if (data.access_token) return { status: "success", token: data.access_token };
    if (data.error === "authorization_pending") return { status: "pending" };
    if (data.error === "slow_down") return { status: "pending" };
    if (data.error === "expired_token") return { status: "expired" };
    return { status: "error", message: data.error_description || data.error || "Unknown error" };
  }

  /** Clear stored token, git config, and in-memory state. */
  clearCredentials(): void {
    this._token = null;
    this._username = null;
    this._avatarUrl = null;

    try {
      if (fs.existsSync(this.tokenPath)) {
        fs.unlinkSync(this.tokenPath);
      }
    } catch {
      // ignore
    }

    try {
      execSync("git config --unset credential.helper", {
        cwd: this.workspaceDir,
        stdio: "pipe",
      });
    } catch {
      // ignore — may not be set
    }
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
          private: options.isPrivate ?? false,
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
   * Load cached user info from GitHub API using stored token.
   * Called on startup when checkCredentials() finds a token file.
   */
  async loadUserInfo(): Promise<void> {
    if (!this._token) return;
    const info = await validateGitHubToken(this._token);
    if (info) {
      this._username = info.username;
      this._avatarUrl = info.avatarUrl;
      this.configureGitCredentials();
    } else {
      // Token is invalid — clear it
      this.clearCredentials();
    }
  }
}
