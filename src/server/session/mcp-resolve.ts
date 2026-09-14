
import type { McpServerConfig } from "./agents/agent-process.js";
import { substituteMcpPlaceholders } from "../shared/mcp-placeholders.js";

export interface McpResolveResult {
  /** Null means a credential is missing; omit this server from the turn. */
  resolved: Record<string, unknown> | null;
  missing: string[];
}

export function resolveMcpServer(
  server: McpServerConfig,
  env: Record<string, string | undefined> = process.env,
): McpResolveResult {
  const missing: string[] = [];

  const subst = (value: string): string => substituteMcpPlaceholders(value, env, missing);

  const substRecord = (rec?: Record<string, string>): Record<string, string> | undefined => {
    if (!rec) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(rec)) out[k] = subst(v);
    return out;
  };

  let resolved: Record<string, unknown>;
  if (server.type === "stdio") {
    resolved = {
      command: server.command,
      ...(server.args ? { args: server.args.map(subst) } : {}),
      ...(server.env ? { env: substRecord(server.env) } : {}),
    };
  } else {
    resolved = {
      type: "http",
      url: server.url,
      ...(server.headers ? { headers: substRecord(server.headers) } : {}),
    };
  }

  if (missing.length > 0) {
    return { resolved: null, missing: [...new Set(missing)] };
  }
  return { resolved, missing: [] };
}
