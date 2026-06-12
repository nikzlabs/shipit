/**
 * Shared types for the consolidated internal MCP bridge (SHI-128 / docs/199).
 *
 * Each internal ShipIt tool (review/present/voice/bug/permission/ask) is a
 * {@link ToolDescriptor}: a tool definition plus a `call()` that forwards to the
 * session worker over localhost HTTP. `mcp-shipit-bridge.ts` registers a
 * configurable subset of these descriptors under ONE stdio MCP server named
 * `shipit`, so all internal tools share a single process instead of five — the
 * memory/density follow-up to the precompile fix.
 */

/** The MCP tool-call result shape every descriptor returns (a single text block). */
export interface McpToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** Cross-cutting dependencies handed to every tool's `call()`. */
export interface ToolDeps {
  /** Base URL of the session worker (`http://127.0.0.1:$WORKER_PORT`). */
  workerUrl: string;
  /** Sleep used by retry backoff — injectable so tests run instantly. */
  sleep: (ms: number) => Promise<void>;
}

/**
 * One internal tool: its MCP definition + the handler that forwards to the
 * worker. `id` is the key used in the `SHIPIT_MCP_TOOLS` subset env; `name` is
 * the MCP tool name the agent calls (becomes `mcp__shipit__<name>`).
 */
export interface ToolDescriptor {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Optional server-level guidance; merged into the consolidated server's instructions. */
  instructions?: string;
  call(args: Record<string, unknown>, deps: ToolDeps): Promise<McpToolResult>;
}
