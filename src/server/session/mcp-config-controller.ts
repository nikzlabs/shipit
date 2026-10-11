import type {
  AgentProcess,
  AgentRunParams,
  AgentMcpBridge,
  AgentMcpWriteResult,
  McpServerConfig,
} from "./agents/agent-process.js";
import { resolveBridge } from "./mcp-bridge-paths.js";
import { substituteMcpPlaceholders } from "../shared/mcp-placeholders.js";
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
      sessionStatusCard: params?.sessionStatusCard === true,
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

  /**
   * docs/327 — each declared server becomes an ordinary stdio entry, so every
   * adapter writes it, and Claude's allowlist covers it, as for an account server.
   */
  withServiceMcpServers(params: AgentRunParams): AgentRunParams {
    const declared = params.serviceMcpServers ?? [];
    if (declared.length === 0) return params;
    const proxy = this.serviceProxyPaths();
    if (!proxy) {
      for (const server of declared) {
        this.deps.broadcast({
          type: "mcp_server_status",
          data: { name: server.name, state: "failed", reason: "ShipIt's MCP service proxy is missing from this session image" },
        });
      }
      return params;
    }
    const names = new Set(declared.map((s) => s.name.toLowerCase()));
    const entries: McpServerConfig[] = declared.map((server) => ({
      name: server.name,
      type: "stdio",
      command: proxy.tsxBin,
      // An argument, not env: Codex sets an MCP child's env for the whole process.
      args: [proxy.bridgePath, server.url],
      enabled: true,
    }));
    return {
      ...params,
      mcpServers: [
        ...(params.mcpServers ?? []).filter((s) => !names.has(s.name.toLowerCase())),
        ...entries,
      ],
    };
  }

  serviceProxyPaths(): AgentMcpBridge | null {
    return resolveBridge("mcp-service-proxy");
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
