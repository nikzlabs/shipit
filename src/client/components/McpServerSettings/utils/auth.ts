import type { McpServerConfig } from "../../../../server/shared/types.js";
import type { McpServerStatusEntry } from "../../../stores/mcp-store.js";

/**
 * If a server's auth is wired to an OAuth connection (its headers reference a
 * `$platform:<source>` token, as the auto-created "Connect with …" entries
 * are), return that source id — otherwise `null`. Used to badge the row as
 * managed by the connection so it doesn't read as a stray duplicate of the
 * "Connected" provider card above.
 */
export function oauthSourceForServer(server: McpServerConfig): string | null {
  if (server.type !== "http" || !server.headers) return null;
  for (const value of Object.values(server.headers)) {
    const m = /\$platform:([a-z][a-z0-9_]*)/.exec(value);
    if (m) return m[1];
  }
  return null;
}

/**
 * The OAuth provider's "Connected" flag and the MCP server's runtime status
 * are independent signals — the former just means we have stored tokens, the
 * latter is what the provider's MCP server answered when the CLI actually
 * tried to use them. They can disagree: tokens get revoked at the provider
 * side, expire without a working refresh token, or fall out of scope. Detect
 * that case so the UI can downgrade "Connected" to "Authentication required"
 * and offer Reconnect.
 *
 * The auth-required reason string is set by the Claude adapter
 * (`mapCliMcpStatus`) as a stable literal — match on `auth` so a future
 * "auth required" / "needs auth" variant still trips this.
 */
export function isAuthRequired(status: McpServerStatusEntry | undefined): boolean {
  if (status?.state !== "failed") return false;
  const reason = status.reason?.toLowerCase() ?? "";
  return reason.includes("auth");
}
