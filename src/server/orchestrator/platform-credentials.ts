/**
 * Platform credential forwarding (087-reusable-preview-secrets, Phase 4).
 *
 * Some secrets in `x-shipit-secrets` reference platform-managed credentials
 * the user has already configured at the ShipIt level (Claude OAuth token,
 * GitHub token) instead of values they have to re-paste into the secrets
 * panel. The compose-file declaration looks like:
 *
 *   x-shipit-secrets:
 *     - name: ANTHROPIC_API_KEY
 *       source: platform:claude_oauth
 *     - name: GITHUB_TOKEN
 *       source: platform:github_token
 *
 * The resolver in `secret-resolver.ts` consults the platform-credential
 * provider when an entry has a `source:` field. If the source is unknown
 * or the credential is unavailable, the entry falls back to the regular
 * user-secret lookup (which usually means "not configured").
 *
 * The flagship use case is ShipIt-in-ShipIt: the inner orchestrator service
 * needs the outer session's Claude OAuth + GitHub tokens. Without
 * forwarding, the user would have to copy-paste their personal credentials
 * into the inner session — fragile, leaks credentials into config, and
 * goes stale when tokens rotate.
 */

import fs from "node:fs";
import path from "node:path";
import type { AuthManager } from "./agents/claude/auth-manager.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { CredentialStore } from "./credential-store.js";
import { MCP_OAUTH_PROVIDERS } from "./mcp-oauth-providers.js";

// ---------------------------------------------------------------------------
// Source identifiers
// ---------------------------------------------------------------------------

/**
 * All recognized `source:` strings. Adding a new source means:
 *   1. Adding an entry here.
 *   2. Wiring it up in {@link createPlatformCredentialProvider}.
 *   3. Documenting it in `src/server/shipit-docs/secrets.md`.
 *
 * Note: MCP OAuth providers (docs/088 Phase 2 — `platform:linear_oauth`,
 * `platform:notion_oauth`, …) are registered dynamically from
 * `mcp-oauth-providers.ts` at provider-list time and don't appear here.
 * They share the same `source:` shape so compose-declared secrets can
 * still reference them (e.g. a future preview service that wants the
 * Linear token); see {@link isPlatformSource} which accepts both.
 */
export const PLATFORM_SOURCES = [
  /** Claude OAuth access token from the orchestrator's AuthManager. */
  "platform:claude_oauth",
  /** GitHub PAT from CredentialStore (via GitHubAuthManager). */
  "platform:github_token",
] as const;

export type PlatformSource = (typeof PLATFORM_SOURCES)[number];

/**
 * True for any source string recognized by the resolver — the hand-maintained
 * {@link PLATFORM_SOURCES} list **or** any MCP OAuth provider id registered
 * in `mcp-oauth-providers.ts` (prefixed with `platform:`).
 */
export function isPlatformSource(s: string): boolean {
  if ((PLATFORM_SOURCES as readonly string[]).includes(s)) return true;
  if (s.startsWith("platform:")) {
    const id = s.slice("platform:".length);
    return MCP_OAUTH_PROVIDERS.some((p) => p.id === id);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/**
 * Resolves a `source:` identifier to a string value. Returns `null` (or
 * empty string) when the credential isn't currently available — the caller
 * treats that the same as a missing user secret.
 *
 * Implementations MUST be cheap and synchronous-ish (no network calls). The
 * resolver is invoked once per `syncSecrets()` pass which can be called on
 * every PUT /api/secrets, so an expensive lookup would compound.
 */
export interface PlatformCredentialProvider {
  resolve(source: string): string | null;
  /**
   * Names of all sources this provider knows how to handle. Used for
   * surface-level introspection (e.g. UI showing available platform
   * sources). Order doesn't matter.
   *
   * Includes the hand-maintained {@link PLATFORM_SOURCES} plus any
   * `platform:<id>` strings derived from the MCP OAuth registry.
   */
  knownSources(): readonly string[];
}

// ---------------------------------------------------------------------------
// Default implementation
// ---------------------------------------------------------------------------

/**
 * Construct the default platform credential provider.
 *
 * Each lookup is "best effort":
 *   - `platform:claude_oauth`: prefer `ANTHROPIC_API_KEY` from the
 *     orchestrator's process env (set by user via Settings → Agent →
 *     Anthropic API key); fall back to reading the Claude CLI's OAuth
 *     access token from the credentials file. Returns `null` when neither
 *     is available.
 *   - `platform:github_token`: read the GitHub PAT via
 *     `CredentialStore.getGithubToken()` (exposed through GitHubAuthManager
 *     authentication state). Returns `null` when no token is configured.
 *
 * The reads are intentionally performed on every call so token rotation
 * (Claude CLI refresh, user reissues GitHub PAT) is picked up on the next
 * `syncSecrets()` without restarting the orchestrator.
 */
export function createPlatformCredentialProvider(deps: {
  authManager: AuthManager;
  githubAuthManager: GitHubAuthManager;
  /**
   * Optional credential store — when present, enables resolution of MCP
   * OAuth providers (docs/088 Phase 2) via `platform:<provider_id>`. When
   * omitted, those sources return `null` and fall through to the user-secret
   * lookup, matching pre-Phase-2 behavior.
   */
  credentialStore?: CredentialStore;
  /** Override the default credentials directory (mainly for tests). */
  claudeCredentialsDir?: string;
}): PlatformCredentialProvider {
  const { githubAuthManager, credentialStore, claudeCredentialsDir } = deps;
  const claudeDir = claudeCredentialsDir ?? "/root/.claude";

  return {
    resolve(source: string): string | null {
      switch (source) {
        case "platform:claude_oauth": {
          const apiKey = process.env.ANTHROPIC_API_KEY;
          if (apiKey && apiKey.length > 0) return apiKey;
          return readClaudeOAuthToken(claudeDir);
        }
        case "platform:github_token": {
          // GitHubAuthManager's checkCredentials() loads the token into
          // memory on startup. We re-fetch via getStatus()-adjacent path
          // so a token added after process start is picked up.
          if (!githubAuthManager.authenticated) {
            // Trigger a re-load in case it was set after startup.
            githubAuthManager.checkCredentials();
          }
          return githubAuthManager.getToken() ?? null;
        }
        default: {
          // MCP OAuth providers — `platform:linear_oauth`, etc. (docs/088 Phase 2)
          if (!credentialStore || !source.startsWith("platform:")) return null;
          const id = source.slice("platform:".length);
          if (!MCP_OAUTH_PROVIDERS.some((p) => p.id === id)) return null;
          const tokens = credentialStore.getMcpOAuthTokens(id);
          return tokens?.accessToken ?? null;
        }
      }
    },
    knownSources: () => {
      const mcpSources = MCP_OAUTH_PROVIDERS.map((p) => `platform:${p.id}`);
      return [...PLATFORM_SOURCES, ...mcpSources];
    },
  };
}

/**
 * Read the OAuth access token from the Claude CLI's credentials file.
 * Returns `null` if the file is missing, malformed, or lacks the expected
 * shape. The file is JSON of the form:
 *   { "claudeAiOauth": { "accessToken": "...", ... } }
 */
function readClaudeOAuthToken(claudeDir: string): string | null {
  const candidates = [".credentials.json", "credentials.json"];
  for (const name of candidates) {
    const filePath = path.join(claudeDir, name);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    let parsed: { claudeAiOauth?: { accessToken?: unknown } };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      continue;
    }
    const token = parsed.claudeAiOauth?.accessToken;
    if (typeof token === "string" && token.length > 0) return token;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a fixed-value provider — useful for tests that want to assert the
 * resolver path without standing up real AuthManager / GitHubAuthManager
 * instances.
 *
 * Accepts any string key (the hand-maintained {@link PlatformSource} list
 * plus any MCP OAuth provider source like `"platform:linear_oauth"`).
 */
export function fixedPlatformCredentialProvider(
  values: Record<string, string>,
): PlatformCredentialProvider {
  return {
    resolve(source: string): string | null {
      if (!isPlatformSource(source)) return null;
      return values[source] ?? null;
    },
    knownSources: () => PLATFORM_SOURCES,
  };
}
