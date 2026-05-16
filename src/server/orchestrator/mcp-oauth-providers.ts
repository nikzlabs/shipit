/**
 * MCP OAuth provider registry (docs/088-mcp-integration §"Phase 2").
 *
 * Static metadata for hosted MCP servers that support OAuth 2.1 + PKCE.
 * Each entry encapsulates the provider-specific auth/token/registration
 * endpoints, scope list, MCP endpoint, and the env-var fallback for a
 * pre-allocated client id (when dynamic client registration isn't available
 * or has been disabled).
 *
 * Adding a new provider: append a new entry to {@link MCP_OAUTH_PROVIDERS}
 * and document it in `src/server/shipit-docs/mcp.md`. The provider id is
 * the user-visible string in `$platform:<id>` placeholders and gets
 * uppercased into the env var name the worker substitutes for the
 * placeholder (`linear_oauth` → `MCP_PLATFORM_LINEAR_OAUTH`).
 *
 * Note: ShipIt does not pre-register OAuth clients with these providers.
 * The first successful auth flow performs RFC 7591 dynamic client
 * registration and caches the resulting `client_id` in
 * `CredentialStore.mcpOAuth[id].clientId`. Operators can short-circuit
 * registration by setting `<ID>_OAUTH_CLIENT_ID` (and optionally
 * `<ID>_OAUTH_CLIENT_SECRET`) on the orchestrator process — useful when a
 * provider has rate limits on dynamic registration or when the operator
 * has gone through the manual application flow.
 */

import type { McpOAuthProviderConfig } from "../shared/types/mcp-types.js";

/**
 * Source id → provider config. Order in the array determines the order in
 * the "Connect with…" button row in Settings.
 */
export const MCP_OAUTH_PROVIDERS: readonly McpOAuthProviderConfig[] = [
  {
    id: "linear_oauth",
    label: "Linear",
    description:
      "Connect to your Linear workspace so the agent can read and file issues, search teams, and update project status.",
    // Public Linear endpoints — verified against the Linear OAuth 2.0 docs
    // (https://developers.linear.app/docs/oauth/authentication).
    authorizationEndpoint: "https://linear.app/oauth/authorize",
    tokenEndpoint: "https://api.linear.app/oauth/token",
    // Linear does not currently support RFC 7591 dynamic registration —
    // operators must create an OAuth application in Linear's settings and
    // set LINEAR_OAUTH_CLIENT_ID (+ optional LINEAR_OAUTH_CLIENT_SECRET).
    clientIdEnv: "LINEAR_OAUTH_CLIENT_ID",
    clientSecretEnv: "LINEAR_OAUTH_CLIENT_SECRET",
    scopes: ["read", "write", "issues:create", "comments:create"],
    mcpUrl: "https://mcp.linear.app/mcp",
    defaultServerName: "linear",
  },
  {
    id: "notion_oauth",
    label: "Notion",
    description:
      "Connect to your Notion workspace so the agent can search pages, read content, and create/update database items.",
    authorizationEndpoint: "https://api.notion.com/v1/oauth/authorize",
    tokenEndpoint: "https://api.notion.com/v1/oauth/token",
    clientIdEnv: "NOTION_OAUTH_CLIENT_ID",
    clientSecretEnv: "NOTION_OAUTH_CLIENT_SECRET",
    // Notion's MCP server reuses the workspace bearer token issued by the
    // OAuth exchange; "read" is the minimum scope that lets the agent
    // search pages and follow databases.
    scopes: [],
    mcpUrl: "https://mcp.notion.com/mcp",
    defaultServerName: "notion",
  },
] as const;

/** Look up a provider config by id. Returns `undefined` for unknown ids. */
export function getMcpOAuthProvider(id: string): McpOAuthProviderConfig | undefined {
  return MCP_OAUTH_PROVIDERS.find((p) => p.id === id);
}

/**
 * Translate a provider source id into the env var name the worker reads
 * when resolving a `$platform:<id>` placeholder. Defined once here so the
 * orchestrator-side writer and the worker-side resolver can't drift.
 */
export function platformSourceEnvName(source: string): string {
  return `MCP_PLATFORM_${source.toUpperCase()}`;
}

/**
 * Inverse of {@link platformSourceEnvName}. Returns `null` for env var names
 * that aren't in the MCP_PLATFORM_* namespace.
 */
export function platformSourceFromEnvName(envName: string): string | null {
  const m = /^MCP_PLATFORM_(.+)$/.exec(envName);
  return m ? m[1].toLowerCase() : null;
}
