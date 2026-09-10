
import type { McpServerConfig } from "./agents/agent-process.js";

export interface McpResolveResult {
  /** Null means a credential is missing; omit this server from the turn. */
  resolved: Record<string, unknown> | null;
  missing: string[];
}

export function substituteMcpPlaceholders(
  value: string,
  env: Record<string, string | undefined>,
  missing: string[],
): string {
  const lookup = (envKey: string): string => {
    const v = env[envKey];
    if (v === undefined || v === "") {
      missing.push(envKey);
      return "";
    }
    return v;
  };
  return value
    .replace(/\$secret:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, key: string) => lookup(key))
    .replace(/\$platform:([a-z][a-z0-9_]*)/g, (_m, source: string) =>
      lookup(`MCP_PLATFORM_${source.toUpperCase()}`),
    );
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
