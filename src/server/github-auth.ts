import { EventEmitter } from "node:events";
import fs from "node:fs";
import { execSync } from "node:child_process";

const DEFAULT_TOKEN_PATH = "/workspace/.github-token";

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
