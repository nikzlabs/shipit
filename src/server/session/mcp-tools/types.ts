
export interface McpToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface ToolDeps {
  workerUrl: string;
  sleep: (ms: number) => Promise<void>;
}

export interface ToolDescriptor {
  /** SHIPIT_MCP_TOOLS selection key. */
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  instructions?: string;
  call(args: Record<string, unknown>, deps: ToolDeps): Promise<McpToolResult>;
}
