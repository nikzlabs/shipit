import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexAdapter } from "./adapter.js";
import type { AgentMcpReviewBridge, McpServerConfig } from "../agent-process.js";

/**
 * docs/125 / docs/155 hair 10 — Codex registers its MCP servers via a
 * `[mcp_servers.*]` block in `~/.codex/config.toml`, not a per-run path like
 * Claude. These tests cover CodexAdapter.writeMcpConfig() in isolation:
 *  - it appends the ShipIt-managed block (review bridge + user servers),
 *  - it's idempotent across repeat calls,
 *  - it never clobbers a user's own config outside the managed block,
 *  - secrets in stdio `env` / HTTP `headers` arrive via runtimeEnv (env
 *    indirection) so the .toml never persists raw secret values.
 *
 * The test stubs `hasFileAuth` so the adapter constructor stays cheap (no
 * filesystem checks); writeMcpConfig() doesn't depend on the spawn path.
 */
describe("CodexAdapter.writeMcpConfig (docs/125, docs/155 hair 10)", () => {
  let codexHome: string;
  let adapter: CodexAdapter;
  const prevHome = process.env.CODEX_HOME;
  const reviewBridge: AgentMcpReviewBridge = {
    tsxBin: "/opt/tsx",
    bridgePath: "/opt/mcp-review-bridge.ts",
  };
  let onServerFailed: ReturnType<typeof vi.fn<(name: string, reason: string) => void>>;

  beforeEach(() => {
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    process.env.CODEX_HOME = codexHome;
    adapter = new CodexAdapter(() => false);
    onServerFailed = vi.fn<(name: string, reason: string) => void>();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  function write(
    servers: McpServerConfig[] = [],
    bridge: AgentMcpReviewBridge | null = reviewBridge,
  ): Record<string, string> | undefined {
    return adapter.writeMcpConfig({
      servers,
      reviewBridge: bridge,
      presentBridge: null,
      onServerFailed,
    }).runtimeEnv;
  }

  const configText = (): string => fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8");

  it("appends a managed [mcp_servers.shipit-review] block pointing at the bridge", () => {
    write();
    const cfg = configText();
    expect(cfg).toContain("[mcp_servers.shipit-review]");
    expect(cfg).toContain("mcp-review-bridge.ts");
    expect(cfg).toMatch(/command = ".+tsx"/);
  });

  it("omits the review bridge when no bridge paths are supplied", () => {
    write([], null);
    expect(configText()).not.toContain("[mcp_servers.shipit-review]");
  });

  it("is idempotent — repeat calls do not duplicate the block", () => {
    write();
    write();
    const occurrences = configText().split("[mcp_servers.shipit-review]").length - 1;
    expect(occurrences).toBe(1);
  });

  it("preserves a user's pre-existing config (append, not clobber)", () => {
    const existing = '[mcp_servers.linear]\ncommand = "linear-mcp"\n';
    fs.writeFileSync(path.join(codexHome, "config.toml"), existing);
    write();
    const cfg = configText();
    expect(cfg).toContain("[mcp_servers.linear]");
    expect(cfg).toContain("[mcp_servers.shipit-review]");
  });

  it("writes enabled stdio MCP servers for Codex without persisting env secrets", () => {
    process.env.mcp__linear__LINEAR_API_KEY = "lin_secret";
    try {
      const runtimeEnv = write([{
        name: "linear",
        type: "stdio",
        command: "npx",
        args: ["-y", "@linear/mcp-server"],
        env: { LINEAR_API_KEY: "$secret:mcp__linear__LINEAR_API_KEY" },
        enabled: true,
      }]);

      const cfg = configText();
      expect(cfg).toContain("[mcp_servers.linear]");
      expect(cfg).toContain('command = "npx"');
      expect(cfg).toContain('args = ["-y", "@linear/mcp-server"]');
      expect(cfg).toContain('env_vars = ["LINEAR_API_KEY"]');
      expect(cfg).not.toContain("lin_secret");
      expect(runtimeEnv).toMatchObject({ LINEAR_API_KEY: "lin_secret" });
    } finally {
      delete process.env.mcp__linear__LINEAR_API_KEY;
    }
  });

  it("writes enabled HTTP MCP servers for Codex using env-backed headers", () => {
    process.env.MCP_PLATFORM_NOTION_OAUTH = "notion_token";
    try {
      const runtimeEnv = write([{
        name: "notion",
        type: "http",
        url: "https://mcp.notion.com/mcp",
        headers: { Authorization: "Bearer $platform:notion_oauth" },
        enabled: true,
      }]);

      const cfg = configText();
      expect(cfg).toContain("[mcp_servers.notion]");
      expect(cfg).toContain('url = "https://mcp.notion.com/mcp"');
      expect(cfg).toContain('env_http_headers = { "Authorization" = "SHIPIT_MCP_NOTION_HTTP_HEADER_0" }');
      expect(cfg).not.toContain("notion_token");
      expect(runtimeEnv).toMatchObject({
        SHIPIT_MCP_NOTION_HTTP_HEADER_0: "Bearer notion_token",
      });
    } finally {
      delete process.env.MCP_PLATFORM_NOTION_OAUTH;
    }
  });

  it("replaces the managed block so removed servers do not linger", () => {
    write([{
      name: "linear",
      type: "stdio",
      command: "linear-mcp",
      enabled: true,
    }]);
    write([]);

    const cfg = configText();
    expect(cfg).not.toContain("[mcp_servers.linear]");
    expect(cfg).toContain("[mcp_servers.shipit-review]");
  });

  it("drops servers with missing secrets and reports them via onServerFailed", () => {
    write([{
      name: "linear",
      type: "stdio",
      command: "linear-mcp",
      env: { LINEAR_API_KEY: "$secret:MISSING_KEY" },
      enabled: true,
    }]);

    const cfg = configText();
    expect(cfg).not.toContain("[mcp_servers.linear]");
    expect(onServerFailed).toHaveBeenCalledWith(
      "linear",
      expect.stringContaining("MISSING_KEY"),
    );
  });
});
