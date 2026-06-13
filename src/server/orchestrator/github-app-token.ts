/**
 * GitHub App installation-token minter (docs/172 Gap 2-R / SHI-79).
 *
 * WHY THIS EXISTS
 * ---------------
 * The git credential broker (`shipit-git-credential` → worker →
 * `getGitCredential`) is *caller-blind*: anything that can run `git` inside a
 * session container can ask the broker for the credential and gets the full,
 * long-lived GitHub PAT back. SHI-72 closed plaintext-at-rest and host-blindness,
 * but the on-demand extraction path remains (an injected agent, a malicious
 * `agent.install`, or a compromised dependency can read the token and exfiltrate
 * it via some other channel — Gap 1 egress, still open).
 *
 * We cannot make the broker caller-aware (git is a legitimate caller and is
 * indistinguishable from the agent). The highest-leverage *defense-in-depth* is
 * to shrink the blast radius of whatever the broker hands out: instead of a
 * long-lived, account-wide PAT, mint a **short-lived, single-repo-scoped GitHub
 * App installation token** and broker *that*. An extracted installation token
 * then (a) works only on the one repo, (b) only for the narrow permission set
 * we request, and (c) expires on its own (GitHub caps installation tokens at one
 * hour and we mint per-turn), so the exfiltration window is bounded without any
 * action from the user.
 *
 * SCOPE OF THIS INCREMENT (the "rest" is documented in the plan/checklist)
 * -----------------------------------------------------------------------
 * ShipIt today authenticates with the *user's own* PAT/OAuth token; there is no
 * GitHub App registered. Standing up the App (registration, per-user/-org
 * installation discovery, private-key secret management) is operator-level infra
 * that is too large for one PR. This module is the self-contained *mechanism*:
 * given operator-supplied App credentials it mints repo-scoped installation
 * tokens; when those credentials are absent it reports `!isConfigured()` and the
 * broker falls back to the existing PAT behavior unchanged. So this ships dark
 * (no behavior change) until an operator opts in, at which point the broker
 * automatically prefers the minted short-lived token.
 *
 * CONFIG (operator-supplied, read from env)
 * -----------------------------------------
 *   - `GITHUB_APP_ID`           — the numeric App id.
 *   - `GITHUB_APP_PRIVATE_KEY`  — the App's RSA private key, either a raw PEM
 *                                 (multi-line) or a base64-encoded PEM (so it
 *                                 survives single-line env/secret stores).
 *
 * No new dependency: the App JWT is signed with `node:crypto` (RS256).
 */

import { createSign } from "node:crypto";
import { getErrorMessage } from "../shared/utils.js";

/** Resolved, validated GitHub App credentials. */
export interface GitHubAppConfig {
  appId: string;
  /** PEM-encoded RSA private key. */
  privateKey: string;
}

/** A minted installation token plus the epoch-ms instant it expires. */
interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/**
 * Re-mint a cached token this many ms before its real expiry. Covers clock skew
 * between us and GitHub and the duration of the git operation the token is for,
 * so a token handed to git is never on the verge of expiring mid-push.
 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * The narrowest permission set that still lets the agent do its job over git +
 * the brokered `gh` shim: read/write repo contents (push/pull/fetch), read/write
 * pull requests (the PR lifecycle), and read metadata (required by GitHub for
 * almost any installation token). Deliberately omits `administration`,
 * `actions`, `secrets`, `members`, etc. — an extracted token cannot touch them.
 */
const INSTALLATION_TOKEN_PERMISSIONS: Record<string, string> = {
  contents: "write",
  pull_requests: "write",
  metadata: "read",
};

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Resolve a private key from its env representation. Accepts a raw PEM
 * (recognized by the `BEGIN` marker, with literal `\n` escapes normalized to
 * real newlines) or a base64-encoded PEM. Returns null if neither yields a PEM.
 */
function normalizePrivateKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Raw PEM (possibly with escaped newlines from a single-line env var).
  if (trimmed.includes("BEGIN")) {
    return trimmed.replace(/\\n/g, "\n");
  }
  // Otherwise assume base64-encoded PEM.
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    return decoded.includes("BEGIN") ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Read App config from the environment. Returns null when either piece is
 * missing or the private key can't be parsed — the manager treats that as
 * "App tokens not configured" and falls back to the PAT.
 */
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

/**
 * Build a short-lived (≤10 min, GitHub's cap) RS256-signed App JWT. `iat` is
 * backdated 60s to absorb clock skew; `exp` is 9 min out to stay under the cap.
 */
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
  /** Resolved App config; defaults to {@link resolveGitHubAppConfigFromEnv}. */
  config?: GitHubAppConfig | null;
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (epoch ms). Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Mints and caches short-lived, single-repo-scoped GitHub App installation
 * tokens. One instance is held by {@link GitHubAuthManager}; it is inert
 * (`isConfigured()` false) until an operator supplies App credentials.
 */
export class GitHubAppTokenMinter {
  private readonly config: GitHubAppConfig | null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** Per-`owner/repo` token cache, so we mint ~once per TTL, not per git call. */
  private readonly cache = new Map<string, CachedToken>();

  constructor(deps: GitHubAppTokenMinterDeps = {}) {
    this.config = deps.config !== undefined ? deps.config : resolveGitHubAppConfigFromEnv();
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Whether an operator has supplied usable App credentials. */
  isConfigured(): boolean {
    return this.config !== null;
  }

  private cacheKey(owner: string, repo: string): string {
    return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  }

  /**
   * Return a valid installation token for `owner/repo`, minting a fresh one when
   * the cache is empty or the cached token is within {@link REFRESH_MARGIN_MS} of
   * expiry. Returns null when App tokens aren't configured or any GitHub call
   * fails — callers (the broker) then fall back to the PAT, preserving
   * availability. Never throws.
   */
  async getRepoToken(owner: string, repo: string): Promise<string | null> {
    if (!this.config) return null;
    if (!owner || !repo) return null;

    const key = this.cacheKey(owner, repo);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAtMs - this.now() > REFRESH_MARGIN_MS) {
      return cached.token;
    }

    try {
      const minted = await this.mint(owner, repo);
      if (!minted) return null;
      this.cache.set(key, minted);
      return minted.token;
    } catch (err) {
      console.warn(`[github-app-token] failed to mint installation token for ${owner}/${repo}: ${getErrorMessage(err)}`);
      return null;
    }
  }

  /** Drop any cached token for `owner/repo` (e.g. after a 401 on use). */
  invalidate(owner: string, repo: string): void {
    this.cache.delete(this.cacheKey(owner, repo));
  }

  /**
   * Discover the installation for `owner/repo` and exchange the App JWT for a
   * repo-scoped, permission-narrowed installation access token.
   */
  private async mint(owner: string, repo: string): Promise<CachedToken | null> {
    const config = this.config;
    if (!config) return null;
    const jwt = buildAppJwt(config, Math.floor(this.now() / 1000));
    const headers = {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "ShipIt",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    // 1. Which installation covers this repo?
    const instRes = await this.fetchImpl(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
      { headers },
    );
    if (!instRes.ok) {
      console.warn(`[github-app-token] installation lookup for ${owner}/${repo} returned HTTP ${instRes.status}`);
      return null;
    }
    const instBody = (await instRes.json().catch(() => null)) as { id?: number } | null;
    const installationId = instBody?.id;
    if (typeof installationId !== "number") {
      console.warn(`[github-app-token] installation lookup for ${owner}/${repo} returned no id`);
      return null;
    }

    // 2. Mint a token scoped to just this repo with the minimal permission set.
    const tokenRes = await this.fetchImpl(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          repositories: [repo],
          permissions: INSTALLATION_TOKEN_PERMISSIONS,
        }),
      },
    );
    if (!tokenRes.ok) {
      console.warn(`[github-app-token] access-token mint for ${owner}/${repo} returned HTTP ${tokenRes.status}`);
      return null;
    }
    const tokenBody = (await tokenRes.json().catch(() => null)) as
      | { token?: string; expires_at?: string }
      | null;
    const token = tokenBody?.token;
    const expiresAt = tokenBody?.expires_at;
    if (typeof token !== "string" || typeof expiresAt !== "string") {
      console.warn(`[github-app-token] access-token mint for ${owner}/${repo} returned an unexpected body`);
      return null;
    }
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      console.warn(`[github-app-token] access-token mint for ${owner}/${repo} returned unparseable expires_at: ${expiresAt}`);
      return null;
    }
    return { token, expiresAtMs };
  }
}
