import type {
  AgentProcess,
  AgentRunParams,
  AgentMcpBridge,
  AgentMcpWriteResult,
  McpServerConfig,
} from "./agents/agent-process.js";
import { resolveBridge } from "./mcp-bridge-paths.js";
import { substituteMcpPlaceholders } from "./mcp-resolve.js";
import type { WorkerSSEEvent } from "./sse-broadcaster.js";

export interface McpConfigDeps {
  broadcast: (event: WorkerSSEEvent) => void;
}

export class McpConfigController {
  constructor(private readonly deps: McpConfigDeps) {}

  invokeAgentMcpWriter(
    agent: AgentProcess,
    params?: AgentRunParams,
  ): AgentMcpWriteResult {
    return agent.writeMcpConfig({
      servers: params?.mcpServers ?? [],
      shipitBridge: this.shipitBridgePaths(),
      onServerFailed: (name, reason) => {
        this.deps.broadcast({
          type: "mcp_server_status",
          data: { name, state: "failed", reason },
        });
      },
    });
  }

  shipitBridgePaths(): AgentMcpBridge | null {
    return resolveBridge("mcp-shipit-bridge");
  }

  // Use the adapter's placeholder rules so the connectivity test sends the same credentials.
  resolveMcpServerConfig(
    server: McpServerConfig,
  ): { ok: true; config: McpServerConfig } | { ok: false; error: string } {
    const missing: string[] = [];
    const subst = (value: string): string =>
      substituteMcpPlaceholders(value, process.env, missing);
    const substRecord = (rec?: Record<string, string>): Record<string, string> | undefined => {
      if (!rec) return undefined;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(rec)) out[k] = subst(v);
      return out;
    };

    let config: McpServerConfig;
    if (server.type === "stdio") {
      config = {
        ...server,
        ...(server.args ? { args: server.args.map(subst) } : {}),
        ...(server.env ? { env: substRecord(server.env) } : {}),
      };
    } else {
      config = {
        ...server,
        ...(server.headers ? { headers: substRecord(server.headers) } : {}),
      };
    }
    if (missing.length > 0) {
      return { ok: false, error: `missing secret: ${[...new Set(missing)].join(", ")}` };
    }
    return { ok: true, config };
  }
}
