import type { McpServerConfig } from "../../../../server/shared/types.js";
import type { McpServerStatusEntry } from "../../../stores/mcp-store.js";

export function oauthSourceForServer(server: McpServerConfig): string | null {
  if (server.type !== "http" || !server.headers) return null;
  for (const value of Object.values(server.headers)) {
    const m = /\$platform:([a-z][a-z0-9_]*)/.exec(value);
    if (m) return m[1];
  }
  return null;
}

/** Detect rejected stored OAuth credentials from runtime status. */
export function isAuthRequired(status: McpServerStatusEntry | undefined): boolean {
  if (status?.state !== "failed") return false;
  const reason = status.reason?.toLowerCase() ?? "";
  return reason.includes("auth");
}
