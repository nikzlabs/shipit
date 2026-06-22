/**
 * mcp-shipit-bridge — the single stdio MCP server that serves ALL of ShipIt's
 * internal tools (SHI-128 / docs/199).
 *
 * Previously each tool ran as its own stdio process (`shipit-review`,
 * `shipit-present`, `shipit-voice`, `shipit-bug`, `shipit-permission`,
 * `shipit-ask`) — up to five per agent, ~138 MB resident even when precompiled.
 * This consolidates them into ONE server named `shipit` (so tool names are
 * `mcp__shipit__<tool>`), cutting process count 5→1 and memory to ~30 MB. The
 * precompile (docs/199) already fixed the 0.5-CPU connect-in-time failure
 * (SHI-126); this is the follow-up density win.
 *
 * Each tool is a {@link ToolDescriptor} in `mcp-tools/`. The enabled SUBSET is
 * selected per agent via the `SHIPIT_MCP_TOOLS` env (comma-separated tool ids),
 * because the agents want different sets: Claude gets
 * `review,present,voice,bug,permission,propose_actions` (it has a native
 * AskUserQuestion); Codex gets `review,present,voice,ask,bug,propose_actions` (it
 * uses native approval, not the permission-prompt tool). `propose_actions`
 * (docs/207) ships to both. An unknown/empty env exposes nothing rather than
 * failing — agent start never breaks on it.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { presentTool } from "./mcp-tools/present.js";
import { voiceTool } from "./mcp-tools/voice.js";
import { bugTool } from "./mcp-tools/bug.js";
import { permissionTool } from "./mcp-tools/permission.js";
import { askTool } from "./mcp-tools/ask.js";
import { proposeActionsTool } from "./mcp-tools/propose-actions.js";
import type { ToolDeps, ToolDescriptor } from "./mcp-tools/types.js";

/** Every internal tool, keyed by its `SHIPIT_MCP_TOOLS` id. */
export const TOOL_REGISTRY: Record<string, ToolDescriptor> = {
  [presentTool.id]: presentTool,
  [voiceTool.id]: voiceTool,
  [bugTool.id]: bugTool,
  [permissionTool.id]: permissionTool,
  [askTool.id]: askTool,
  [proposeActionsTool.id]: proposeActionsTool,
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function defaultDeps(): ToolDeps {
  return {
    workerUrl: `http://127.0.0.1:${process.env.WORKER_PORT || "9100"}`,
    sleep: realSleep,
  };
}

/** Parse a `SHIPIT_MCP_TOOLS` value into the resolved descriptor list (unknown ids dropped). */
export function selectTools(spec: string | undefined): ToolDescriptor[] {
  if (!spec) return [];
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => TOOL_REGISTRY[id])
    .filter((t): t is ToolDescriptor => Boolean(t));
}

/**
 * Build the consolidated MCP `Server` exposing the given tools. Factored out of
 * the entry point (mirrors `createPresentBridgeServer`) so tests can drive it
 * over an in-process transport pair without spawning stdio. `deps` is injectable
 * so tests can point at a stub worker and make the permission backoff instant.
 * Pure construction — no I/O until the returned server is connected.
 */
export function createShipitBridgeServer(
  tools: ToolDescriptor[],
  deps: ToolDeps = defaultDeps(),
) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  // Merge per-tool guidance into the server instructions (present contributes today).
  const instructions = tools
    .map((t) => t.instructions)
    .filter((s): s is string => Boolean(s))
    .join("\n\n");

  // Low-level Server (not McpServer) so we can pass plain JSON Schema rather than
  // zod schemas — keeps zod transitive. Mirrors the per-tool bridges it replaces.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const server = new Server(
    { name: "shipit", version: "1.0.0" },
    { capabilities: { tools: {} }, ...(instructions ? { instructions } : {}) },
  );

  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    }),
  );

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = byName.get(req.params.name);
    if (!tool) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }
    // The descriptor's typed result is a structural subset of the SDK's
    // CallToolResult (text blocks only, no index signature); cast to satisfy the
    // handler's expected return type.
    return tool.call(req.params.arguments ?? {}, deps) as Promise<CallToolResult>;
  });

  return server;
}

// Connect over stdio only when run as the entry point (the agent CLI spawns this
// file directly). Importing the module — e.g. from a test — must NOT touch
// stdin/stdout. Mirrors the guard in the per-tool bridges it replaces.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  const tools = selectTools(process.env.SHIPIT_MCP_TOOLS);
  await createShipitBridgeServer(tools).connect(new StdioServerTransport());
}
