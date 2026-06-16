import { useState } from "react";
import { useMcpStore } from "../../../stores/mcp-store.js";
import type { McpHttpServerConfig } from "../../../../server/shared/types.js";

/**
 * Owns the OAuth connect/disconnect/reconnect flow for the provider cards.
 * On a successful connect it auto-creates a placeholder HTTP server entry
 * wired to the provider's MCP URL with the bearer header pre-filled, and
 * clears any stale auth-required status so a reconnect flips the card back to
 * "Connected" without waiting for the next CLI init event.
 */
export function useMcpOAuthFlow() {
  const servers = useMcpStore((s) => s.servers);
  const oauthProviders = useMcpStore((s) => s.oauthProviders);
  const addServer = useMcpStore((s) => s.addServer);
  const startOAuthFlow = useMcpStore((s) => s.startOAuthFlow);
  const disconnectOAuth = useMcpStore((s) => s.disconnectOAuth);
  const clearStatus = useMcpStore((s) => s.clearStatus);

  /** Source id currently mid-flow (button disabled, label "Connecting…"). */
  const [oauthInFlight, setOauthInFlight] = useState<string | null>(null);

  async function connectProvider(source: string) {
    setOauthInFlight(source);
    try {
      const result = await startOAuthFlow(source);
      if (result.ok) {
        // After a successful connect, auto-create a placeholder MCP server
        // entry pointing at the provider's MCP URL with the OAuth bearer
        // header pre-wired. The user can edit the name / disable later.
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
            // The server might already exist or another validation issue —
            // the OAuth token is still saved and the UI shows "Connected",
            // so this is best-effort.
          }
        }
        // Reconnect path: drop the stale `failed — authentication required`
        // status that's keeping the card red. The next CLI init event will
        // emit the real status; until then we show plain "Connected" rather
        // than lie about being `loaded`.
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
