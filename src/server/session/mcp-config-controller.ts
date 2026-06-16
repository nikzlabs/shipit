/**
 * MCP config controller — the cross-cutting MCP bits the worker owns, shared by
 * the agent-start path (per-spawn `writeMcpConfig`) and the `/mcp/test`
 * connectivity probe (placeholder resolution). Holds no routes of its own; it's
 * a helper the agent and install controllers consume. (docs/088, docs/155, docs/199)
 */

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
  /** Broadcast an SSE event to all connected clients (failure reporting). */
  broadcast: (event: WorkerSSEEvent) => void;
}

export class McpConfigController {
  constructor(private readonly deps: McpConfigDeps) {}

  /**
   * Build the per-spawn context the adapter's `writeMcpConfig()` consumes.
   * The worker owns the cross-cutting bits — the user-configured server list,
   * the resolved review-bridge install paths, and the SSE failure broadcast —
   * and the adapter owns the CLI-specific wire format. (docs/155 hair 10)
   */
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

  /**
   * Resolve how to launch the consolidated internal MCP bridge (SHI-128).
   * `resolveBridge` (docs/199) prefers the precompiled JS bundle in
   * `dist/mcp-bridges/` (launched with `node` — no per-spawn tsx compile, which
   * is what made the bridges miss the CLI's 2000ms MCP pre-wait at the 0.5-CPU
   * AGENT_DEFAULTS) and falls back to running the `.ts` source through tsx in
   * dev/local images. Returns null when neither exists (stripped-down test
   * image) so the adapter omits the entry rather than failing agent start. The
   * adapter selects which tools the `shipit` server exposes (review/present/
   * voice/bug/permission for Claude; review/present/voice/ask/bug for Codex) via
   * the `SHIPIT_MCP_TOOLS` env — there is one process, not six.
   */
  shipitBridgePaths(): AgentMcpBridge | null {
    return resolveBridge("mcp-shipit-bridge");
  }

  /**
   * Resolve `$secret:` and `$platform:` placeholders in a user MCP server
   * config against `process.env`, returning a fully-resolved
   * `McpServerConfig`. Used by the test endpoint. Returns `{ ok: false }`
   * when a referenced secret/token is absent.
   *
   * Delegates substitution to the shared {@link substituteMcpPlaceholders}
   * helper so the test path understands the exact same placeholder forms as
   * the adapter's `writeMcpConfig()` — including `$platform:<source>` used by
   * OAuth-managed servers. Without this, testing a connected Notion/Linear
   * server sent the literal `$platform:…` header and the provider returned a
   * misleading 401.
   */
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
