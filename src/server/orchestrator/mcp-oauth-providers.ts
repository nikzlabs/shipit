import type { McpOAuthProviderConfig } from "../shared/types/mcp-types.js";

export const MCP_OAUTH_PROVIDERS: readonly McpOAuthProviderConfig[] = [
  {
    id: "notion_oauth",
    label: "Notion",
    description:
      "Connect to your Notion workspace so the agent can search pages, read content, and create/update database items.",
    // MCP authorization endpoints differ from Notion's public-integration OAuth endpoints.
    authorizationEndpoint: "https://mcp.notion.com/authorize",
    tokenEndpoint: "https://mcp.notion.com/token",
    registrationEndpoint: "https://mcp.notion.com/register",
    clientIdEnv: "NOTION_OAUTH_CLIENT_ID",
    clientSecretEnv: "NOTION_OAUTH_CLIENT_SECRET",
    scopes: [],
    mcpUrl: "https://mcp.notion.com/mcp",
    defaultServerName: "notion",
  },
] as const;

export function getMcpOAuthProvider(id: string): McpOAuthProviderConfig | undefined {
  return MCP_OAUTH_PROVIDERS.find((p) => p.id === id);
}

export function platformSourceEnvName(source: string): string {
  return `MCP_PLATFORM_${source.toUpperCase()}`;
}
