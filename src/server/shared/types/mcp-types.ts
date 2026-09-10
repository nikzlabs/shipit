// Stored by name (record[name].name === name); transported as arrays. Secrets stay separate.
export interface McpStdioServerConfig {
  name: string;
  type: "stdio";
  command: string;
  args?: string[];
  /** May contain $secret:<agentEnv-key> placeholders, resolved in the worker. */
  env?: Record<string, string>;
  npmPackage?: string;
  setup?: string;
  enabled: boolean;
}

export interface McpHttpServerConfig {
  name: string;
  type: "http";
  url: string;
  /** $secret: placeholders are substring-substituted, including within Bearer values. */
  headers?: Record<string, string>;
  enabled: boolean;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export type McpServerState = "loaded" | "failed" | "crashed" | "disabled";

export interface McpServerStatus {
  name: string;
  state: McpServerState;
  reason?: string;
}

export interface McpTool {
  name: string;
  description?: string;
}

export type McpTestResult =
  | { ok: true; tools: McpTool[] }
  | { ok: false; error: string };

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms; absent means no expiry. */
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
  clientId?: string;
  clientSecret?: string;
  obtainedAt?: string;
}

/** Separate from tokens: registration alone must not report a connected account. */
export interface McpOAuthRegisteredClient {
  clientId: string;
  clientSecret?: string;
  registeredAt: number;
}

export interface McpOAuthProviderConfig {
  /** Matches [a-z][a-z0-9_]* for conversion to an MCP_PLATFORM_* variable. */
  id: string;
  label: string;
  description?: string;
  /** Fallback when discovery fails. */
  authorizationEndpoint: string;
  /** Refresh uses this directly; it must name the MCP authorization server. */
  tokenEndpoint: string;
  registrationEndpoint?: string;
  clientIdEnv?: string;
  clientSecretEnv?: string;
  scopes: string[];
  mcpUrl: string;
  defaultServerName: string;
}

export interface McpOAuthStatus {
  source: string;
  connected: boolean;
  expiresAt?: number;
  obtainedAt?: string;
  scope?: string;
}
