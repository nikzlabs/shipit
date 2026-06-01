import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { ClaudeAdapter } from "./adapter.js";
import type { AgentMcpReviewBridge, McpServerConfig } from "../agent-process.js";

/**
 * docs/088 / docs/125 / docs/155 hair 10 — ClaudeAdapter writes a per-turn
 * `--mcp-config` JSON file bundling the built-in Playwright server, the
 * internal review bridge (when present), and any user-configured MCP servers
 * (with `$secret:` placeholders resolved against process.env). Missing
 * secrets drop the server and report it back via onServerFailed.
 */
describe("ClaudeAdapter.writeMcpConfig (docs/155 hair 10)", () => {
  let adapter: ClaudeAdapter;
  let onServerFailed: ReturnType<typeof vi.fn<(name: string, reason: string) => void>>;
  const writtenPaths: string[] = [];
  const reviewBridge: AgentMcpReviewBridge = {
    tsxBin: "/opt/tsx",
    bridgePath: "/opt/mcp-review-bridge.ts",
  };

  beforeEach(() => {
    // Adapter is constructed with a minimal stub inner so the wireEvents
    // setup doesn't try to spawn anything. writeMcpConfig() doesn't touch
    // inner — it only writes the JSON file.
    adapter = new ClaudeAdapter(new EventEmitter() as never);
    onServerFailed = vi.fn<(name: string, reason: string) => void>();
  });

  afterEach(() => {
    for (const p of writtenPaths) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
    writtenPaths.length = 0;
  });

  function write(servers: McpServerConfig[] = [], bridge: AgentMcpReviewBridge | null = reviewBridge): {
    config: Record<string, unknown>;
    cleanup?: () => void;
  } {
    const result = adapter.writeMcpConfig({
      servers,
      reviewBridge: bridge,
      presentBridge: null,
      voiceBridge: null,
      onServerFailed,
    });
    if (!result.mcpConfigPath) throw new Error("expected mcpConfigPath");
    writtenPaths.push(result.mcpConfigPath);
    const raw = fs.readFileSync(result.mcpConfigPath, "utf-8");
    return { config: JSON.parse(raw) as Record<string, unknown>, cleanup: result.cleanup };
  }

  it("always emits the built-in playwright server", () => {
    const { config } = write();
    const servers = config.mcpServers as Record<string, unknown>;
    expect(servers.playwright).toBeDefined();
  });

  it("includes the review bridge when the worker resolved its paths", () => {
    const { config } = write();
    const servers = config.mcpServers as Record<string, { command: string }>;
    expect(servers["shipit-review"]).toEqual({
      command: reviewBridge.tsxBin,
      args: [reviewBridge.bridgePath],
    });
  });

  it("omits the review bridge when none is available", () => {
    const { config } = write([], null);
    const servers = config.mcpServers as Record<string, unknown>;
    expect(servers["shipit-review"]).toBeUndefined();
  });

  it("substitutes $secret: placeholders against process.env", () => {
    process.env.mcp__linear__LINEAR_API_KEY = "lin_secret";
    try {
      const { config } = write([{
        name: "linear",
        type: "stdio",
        command: "npx",
        args: ["-y", "@linear/mcp-server"],
        env: { LINEAR_API_KEY: "$secret:mcp__linear__LINEAR_API_KEY" },
        enabled: true,
      }]);
      const servers = config.mcpServers as Record<string, { env: Record<string, string> }>;
      expect(servers.linear.env).toEqual({ LINEAR_API_KEY: "lin_secret" });
    } finally {
      delete process.env.mcp__linear__LINEAR_API_KEY;
    }
  });

  it("drops servers with missing secrets and reports them via onServerFailed", () => {
    const { config } = write([{
      name: "linear",
      type: "stdio",
      command: "linear-mcp",
      env: { LINEAR_API_KEY: "$secret:MISSING_KEY" },
      enabled: true,
    }]);
    const servers = config.mcpServers as Record<string, unknown>;
    expect(servers.linear).toBeUndefined();
    expect(onServerFailed).toHaveBeenCalledWith(
      "linear",
      expect.stringContaining("MISSING_KEY"),
    );
  });

  it("returns a cleanup that unlinks the per-turn config file", () => {
    const result = adapter.writeMcpConfig({
      servers: [],
      reviewBridge,
      presentBridge: null,
      voiceBridge: null,
      onServerFailed,
    });
    expect(result.mcpConfigPath).toBeDefined();
    expect(fs.existsSync(result.mcpConfigPath!)).toBe(true);
    result.cleanup?.();
    expect(fs.existsSync(result.mcpConfigPath!)).toBe(false);
  });
});
