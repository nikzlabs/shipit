// ---- MCP server integration types (docs/088-mcp-integration) ----
//
// Users configure MCP servers at the account level. Configs are stored in
// `CredentialStore.mcpServers` keyed by name; secret values live separately
// in `CredentialStore.agentEnv` under the `mcp__<server>__<KEY>` namespace and
// are referenced from the config blob via `$secret:` placeholders.
//
// Storage form is a map (`Record<string, McpServerConfig>`); transport form
// (HTTP responses, `AgentRunParams`, the client store) is always an array of
// values. The invariant is `record[name].name === name`.

/** A stdio MCP server — spawned as a child process of the Claude CLI. */
export interface McpStdioServerConfig {
  name: string;
  type: "stdio";
  /** Command to run (e.g. "npx"). */
  command: string;
  /** Command arguments (e.g. ["-y", "@anthropic-ai/linear-mcp"]). */
  args?: string[];
  /**
   * Environment variables the spawned process receives. Values may be literal
   * strings or `$secret:<agentEnv-key>` placeholders resolved inside the worker.
   */
  env?: Record<string, string>;
  /** npm package to `npm install -g` at session activation. */
  npmPackage?: string;
  /** Optional setup command run before the server starts (non-npm servers). */
  setup?: string;
  enabled: boolean;
}

/** An HTTP MCP server — reached via an outbound Streamable HTTP connection. */
export interface McpHttpServerConfig {
  name: string;
  type: "http";
  /** Streamable HTTP endpoint URL. */
  url: string;
  /**
   * HTTP headers for the connection. Values may contain `$secret:` placeholders
   * (substring-substituted, so `"Bearer $secret:mcp__x__TOKEN"` works).
   */
  headers?: Record<string, string>;
  enabled: boolean;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

/** Per-server runtime status surfaced by the worker over SSE. */
export type McpServerState = "loaded" | "failed" | "crashed" | "disabled";

/** A structured per-server status event emitted by the worker. */
export interface McpServerStatus {
  name: string;
  state: McpServerState;
  /** Human-readable reason when `state` is "failed" or "crashed". */
  reason?: string;
}

/** A single tool discovered from an MCP server (used by the test endpoint). */
export interface McpTool {
  name: string;
  description?: string;
}

/** Result of the connectivity-test endpoint. */
export type McpTestResult =
  | { ok: true; tools: McpTool[] }
  | { ok: false; error: string };

// ---- Phase 2: MCP OAuth (docs/088-mcp-integration §"Phase 2") ----
//
// For hosted MCP servers (Linear, Notion) the user clicks "Connect" instead
// of pasting a Bearer token. The orchestrator runs an OAuth 2.1 + PKCE flow,
// stores the resulting tokens in `CredentialStore.mcpOAuth`, and the server
// config references the access token via `$platform:<source_id>` placeholders
// resolved by the session worker against `MCP_PLATFORM_<UPPER_UNDERSCORED>`
// env vars (the env vars themselves arrive via 087's agent-env transport).
//
// One connection per provider per account. Multi-instance (e.g. multiple
// Linear workspaces) is Phase 3.

/**
 * OAuth tokens persisted in `CredentialStore.mcpOAuth` keyed by provider source
 * id (e.g. "linear_oauth"). Token rotation happens lazily in the resolver:
 * whenever a `resolve()` call finds `expiresAt < now + safetyMargin`, the
 * resolver swaps the refresh token for a new access token, persists, and
 * returns the new access token.
 */
export interface OAuthTokens {
  /** Bearer token sent to the MCP server. */
  accessToken: string;
  /** Used to mint a new access token when the current one is near expiry. */
  refreshToken?: string;
  /** Unix epoch ms when `accessToken` expires. Absent → never expires. */
  expiresAt?: number;
  /** Type of token (almost always "Bearer"). */
  tokenType?: string;
  /** Space-separated list of granted scopes (informational). */
  scope?: string;
  /**
   * Dynamic-client-registration result, persisted so refresh / re-auth can
   * reuse the same client identity. Optional — providers that pre-allocate
   * client ids via env vars don't fill this in.
   */
  clientId?: string;
  /** Client secret if the provider issued one (confidential clients only). */
  clientSecret?: string;
  /** ISO-8601 timestamp of the last successful exchange/refresh. */
  obtainedAt?: string;
}

/**
 * Static metadata for an OAuth provider that ShipIt knows how to talk to.
 * The registry in `mcp-oauth-providers.ts` exports one of these per supported
 * provider (Linear, Notion, …). All MCP OAuth providers use PKCE; client
 * secrets are optional.
 */
export interface McpOAuthProviderConfig {
  /**
   * Source id used in `$platform:<id>` placeholders and in stored token keys.
   * Must match `[a-z][a-z0-9_]*` so it can be uppercased into a valid env var
   * name (`linear_oauth` → `MCP_PLATFORM_LINEAR_OAUTH`).
   */
  id: string;
  /** Human-readable label for the Settings UI. */
  label: string;
  /** Short marketing copy for the "Connect with X" button row. */
  description?: string;
  /** OAuth 2.1 authorization endpoint. */
  authorizationEndpoint: string;
  /** OAuth 2.1 token endpoint (for code exchange and refresh). */
  tokenEndpoint: string;
  /**
   * Optional dynamic-client-registration endpoint (RFC 7591). When omitted
   * the provider requires a pre-allocated client_id supplied via env var
   * (see `clientIdEnv`).
   */
  registrationEndpoint?: string;
  /**
   * Env var name that may carry a pre-allocated client_id (e.g.
   * `LINEAR_OAUTH_CLIENT_ID`). Checked before falling back to dynamic
   * registration.
   */
  clientIdEnv?: string;
  /** Optional env var name for a confidential client secret. */
  clientSecretEnv?: string;
  /** Scopes requested at auth time. Space-joined in the auth URL. */
  scopes: string[];
  /**
   * MCP endpoint URL — used by the UI to pre-fill the server config when the
   * user clicks "Connect with Linear" so they don't have to type the URL.
   */
  mcpUrl: string;
  /**
   * Default server name used when auto-creating a server config on connect
   * (e.g. "linear"). Must be a valid MCP server name (no hyphens — see
   * `services/mcp.ts` `NAME_RE`).
   */
  defaultServerName: string;
}

/**
 * Per-source connection state returned by `GET /api/mcp-servers/oauth/status`.
 * Never includes raw tokens — only enough for the UI to render "Connected"
 * / "Disconnected" badges with optional expiry hints.
 */
export interface McpOAuthStatus {
  source: string;
  connected: boolean;
  expiresAt?: number;
  obtainedAt?: string;
  scope?: string;
}
