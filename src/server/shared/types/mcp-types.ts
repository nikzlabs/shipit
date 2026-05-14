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
