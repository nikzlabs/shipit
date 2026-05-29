/**
 * Pure MCP config-resolution helpers used by the session worker.
 *
 * Extracted from `session-worker.ts` so the substring-substitution logic
 * (`$secret:KEY` → `env[KEY]`) is unit-testable without spinning up a
 * Fastify worker. The worker itself is responsible for emitting SSE events
 * and writing the resolved config to disk — this module just answers
 * "given this user config and this env, what should the resolved entry
 * look like, and which keys are missing?".
 *
 * See docs/088-mcp-integration.md (§"Agent start flow" and §"Substitution rule").
 */

import type { McpServerConfig } from "./agents/agent-process.js";

/** Result of resolving a single user MCP server config. */
export interface McpResolveResult {
  /**
   * The Claude-CLI `--mcp-config` entry shape with `$secret:` placeholders
   * substituted, or `null` if any referenced env var is missing. The worker
   * uses `null` as the signal to drop the server from this turn's config.
   */
  resolved: Record<string, unknown> | null;
  /**
   * Distinct env var names that were referenced but missing/empty. Used to
   * build the `mcp_server_status` failure reason string. Always empty when
   * `resolved !== null`.
   */
  missing: string[];
}

/**
 * Resolve a single user MCP server config. Walks every string in `env`,
 * `headers`, and `args` and applies two placeholder regexes:
 *
 *   `/\$secret:([A-Za-z_][A-Za-z0-9_]*)/g`   → `env[capturedGroup]`
 *   `/\$platform:([a-z][a-z0-9_]*)/g`        → `env[MCP_PLATFORM_<UPPER>]`
 *
 * Both substitutions are **substring** — `"Bearer $secret:mcp__x__TOKEN"`
 * keeps the literal `Bearer ` prefix; `"Bearer $platform:linear_oauth"`
 * looks up `MCP_PLATFORM_LINEAR_OAUTH`. The orchestrator-side writer
 * (`collectMcpAgentEnv()` in `secret-resolver.ts`) is responsible for
 * populating `MCP_PLATFORM_*` env vars from `CredentialStore.mcpOAuth`
 * before this resolver runs.
 *
 * Missing env vars cause the entire server to be dropped (returns
 * `resolved: null`). The caller is responsible for emitting an
 * `mcp_server_status` failure event with the `missing` list. Missing
 * platform sources are reported under the `MCP_PLATFORM_<UPPER>` env-var
 * name they would have been read from — that's what the user sees in
 * orchestrator logs, so consistency aids debugging.
 *
 * Note: we treat `undefined` and `""` identically as "missing" — a worker
 * with `LINEAR_API_KEY=""` in its env can't authenticate to Linear, so the
 * server should be dropped rather than spawned with an empty credential.
 */
/**
 * Apply `$secret:` and `$platform:` substitution to a single string, pushing
 * any missing/empty referenced env keys onto `missing`.
 *
 *   `/\$secret:([A-Za-z_][A-Za-z0-9_]*)/g`   → `env[capturedGroup]`
 *   `/\$platform:([a-z][a-z0-9_]*)/g`        → `env[MCP_PLATFORM_<UPPER>]`
 *
 * Exported so every codepath that turns a stored MCP config into a live
 * config — each agent adapter's `writeMcpConfig()` (via
 * {@link resolveMcpServer}) AND the worker's `/mcp/test` connectivity check —
 * substitutes the SAME placeholder forms. Previously the test path had its own copy that only
 * understood `$secret:`, so testing an OAuth-managed server (whose auth
 * header is `Bearer $platform:<source>`) sent the unresolved literal and the
 * provider answered `401`, even though the agent could use the server fine.
 */
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
