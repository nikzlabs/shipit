import { useState } from "react";
import { useMcpStore } from "../../../stores/mcp-store.js";
import type { McpHttpServerConfig } from "../../../../server/shared/types.js";

export function useMcpOAuthFlow() {
  const servers = useMcpStore((s) => s.servers);
  const oauthProviders = useMcpStore((s) => s.oauthProviders);
  const addServer = useMcpStore((s) => s.addServer);
  const startOAuthFlow = useMcpStore((s) => s.startOAuthFlow);
  const disconnectOAuth = useMcpStore((s) => s.disconnectOAuth);
  const clearStatus = useMcpStore((s) => s.clearStatus);

  const [oauthInFlight, setOauthInFlight] = useState<string | null>(null);

  async function connectProvider(source: string) {
    setOauthInFlight(source);
    try {
      const result = await startOAuthFlow(source);
      if (result.ok) {
        const provider = oauthProviders.find((p) => p.id === source);
        if (provider && !servers.some((s) => s.name === provider.defaultServerName)) {
          const config: McpHttpServerConfig = {
            name: provider.defaultServerName,
            type: "http",
            url: provider.mcpUrl,
            headers: { Authorization: `Bearer $platform:${source}` },
            enabled: true,
          };
          try {
            await addServer(config, {});
          } catch {
            // OAuth succeeded, so server creation remains best effort.
          }
        }
        // The next CLI init will replace this stale failure with live status.
        if (provider) {
          clearStatus(provider.defaultServerName);
        }
      }
    } finally {
      setOauthInFlight(null);
    }
  }

  async function disconnectProvider(source: string) {
    setOauthInFlight(source);
    try {
      await disconnectOAuth(source);
    } catch {
      /* error surfaced via store.oauthError */
    } finally {
      setOauthInFlight(null);
    }
  }

  return { oauthInFlight, connectProvider, disconnectProvider };
}
