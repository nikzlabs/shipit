import { createSign } from "node:crypto";
import { getErrorMessage } from "../shared/utils.js";

export interface GitHubAppConfig {
  appId: string;
  /** PEM-encoded RSA private key. */
  privateKey: string;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

// Allow for clock skew and the duration of the next Git operation.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export type AppTokenScope = "write" | "read";

const INSTALLATION_TOKEN_PERMISSIONS: Record<AppTokenScope, Record<string, string>> = {
  write: {
    contents: "write",
    pull_requests: "write",
    metadata: "read",
  },
  read: {
    contents: "read",
    metadata: "read",
  },
};

export type AppTokenMintFailure = "not_configured" | "not_installed" | "mint_failed";

export type AppTokenMintResult =
  | { ok: true; token: string }
  | { ok: false; reason: AppTokenMintFailure };

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function normalizePrivateKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.includes("BEGIN")) {
    return trimmed.replace(/\\n/g, "\n");
  }
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    return decoded.includes("BEGIN") ? decoded : null;
  } catch {
    return null;
  }
}

export function resolveGitHubAppConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GitHubAppConfig | null {
  const appId = env.GITHUB_APP_ID?.trim();
  const rawKey = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !rawKey) return null;
  const privateKey = normalizePrivateKey(rawKey);
  if (!privateKey) {
    console.warn("[github-app-token] GITHUB_APP_PRIVATE_KEY is set but not a parseable PEM — ignoring App config");
    return null;
  }
  return { appId, privateKey };
}

// Backdate for clock skew while keeping the JWT lifetime within ten minutes.
export function buildAppJwt(config: GitHubAppConfig, nowSec: number): string {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: nowSec - 60, exp: nowSec + 9 * 60, iss: config.appId };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const sign = createSign("RSA-SHA256");
  sign.update(signingInput);
  sign.end();
  const signature = sign.sign(config.privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

export interface GitHubAppTokenMinterDeps {
  config?: GitHubAppConfig | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class GitHubAppTokenMinter {
  private readonly config: GitHubAppConfig | null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly cache = new Map<string, CachedToken>();

  constructor(deps: GitHubAppTokenMinterDeps = {}) {
    this.config = deps.config !== undefined ? deps.config : resolveGitHubAppConfigFromEnv();
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => Date.now());
  }

  isConfigured(): boolean {
    return this.config !== null;
  }

  private cacheKey(owner: string, repo: string, scope: AppTokenScope): string {
    return `${owner.toLowerCase()}/${repo.toLowerCase()}#${scope}`;
  }

  async getRepoToken(owner: string, repo: string): Promise<string | null> {
    const result = await this.getRepoTokenResult(owner, repo, "write");
    return result.ok ? result.token : null;
  }

  async getRepoTokenResult(
    owner: string,
    repo: string,
    scope: AppTokenScope = "write",
  ): Promise<AppTokenMintResult> {
    if (!this.config) return { ok: false, reason: "not_configured" };
    if (!owner || !repo) return { ok: false, reason: "mint_failed" };

    const key = this.cacheKey(owner, repo, scope);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAtMs - this.now() > REFRESH_MARGIN_MS) {
      return { ok: true, token: cached.token };
    }

    try {
      const minted = await this.mint(owner, repo, scope);
      if (!minted.ok) return minted;
      this.cache.set(key, minted.value);
      return { ok: true, token: minted.value.token };
    } catch (err) {
      console.warn(`[github-app-token] failed to mint installation token for ${owner}/${repo}: ${getErrorMessage(err)}`);
      return { ok: false, reason: "mint_failed" };
    }
  }

  invalidate(owner: string, repo: string): void {
    for (const scope of ["write", "read"] as const) {
      this.cache.delete(this.cacheKey(owner, repo, scope));
    }
  }

  private async mint(
    owner: string,
    repo: string,
    scope: AppTokenScope,
  ): Promise<{ ok: true; value: CachedToken } | { ok: false; reason: AppTokenMintFailure }> {
    const config = this.config;
    if (!config) return { ok: false, reason: "not_configured" };
    const jwt = buildAppJwt(config, Math.floor(this.now() / 1000));
    const headers = {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "ShipIt",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    const instRes = await this.fetchImpl(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
      { headers },
    );
    if (!instRes.ok) {
      console.warn(`[github-app-token] installation lookup for ${owner}/${repo} returned HTTP ${instRes.status}`);
      // GitHub also returns 404 for a nonexistent repository.
      return { ok: false, reason: instRes.status === 404 ? "not_installed" : "mint_failed" };
    }
    const instBody = (await instRes.json().catch(() => null)) as { id?: number } | null;
    const installationId = instBody?.id;
    if (typeof installationId !== "number") {
      console.warn(`[github-app-token] installation lookup for ${owner}/${repo} returned no id`);
      return { ok: false, reason: "mint_failed" };
    }

    const tokenRes = await this.fetchImpl(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          repositories: [repo],
          permissions: INSTALLATION_TOKEN_PERMISSIONS[scope],
        }),
      },
    );
    if (!tokenRes.ok) {
      console.warn(`[github-app-token] access-token mint for ${owner}/${repo} returned HTTP ${tokenRes.status}`);
      return { ok: false, reason: "mint_failed" };
    }
    const tokenBody = (await tokenRes.json().catch(() => null)) as
      | { token?: string; expires_at?: string }
      | null;
    const token = tokenBody?.token;
    const expiresAt = tokenBody?.expires_at;
    if (typeof token !== "string" || typeof expiresAt !== "string") {
      console.warn(`[github-app-token] access-token mint for ${owner}/${repo} returned an unexpected body`);
      return { ok: false, reason: "mint_failed" };
    }
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      console.warn(`[github-app-token] access-token mint for ${owner}/${repo} returned unparseable expires_at: ${expiresAt}`);
      return { ok: false, reason: "mint_failed" };
    }
    return { ok: true, value: { token, expiresAtMs } };
  }
}
