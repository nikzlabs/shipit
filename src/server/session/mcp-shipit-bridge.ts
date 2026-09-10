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

export function selectTools(spec: string | undefined): ToolDescriptor[] {
  if (!spec) return [];
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => TOOL_REGISTRY[id])
    .filter((t): t is ToolDescriptor => Boolean(t));
}

export function createShipitBridgeServer(
  tools: ToolDescriptor[],
  deps: ToolDeps = defaultDeps(),
) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const instructions = tools
    .map((t) => t.instructions)
    .filter((s): s is string => Boolean(s))
    .join("\n\n");

  // Low-level Server accepts JSON Schema without a direct zod dependency.
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
    return tool.call(req.params.arguments ?? {}, deps) as Promise<CallToolResult>;
  });

  return server;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  const tools = selectTools(process.env.SHIPIT_MCP_TOOLS);
  await createShipitBridgeServer(tools).connect(new StdioServerTransport());
}
