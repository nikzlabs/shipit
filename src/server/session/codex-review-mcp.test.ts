import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionWorker } from "./session-worker.js";
import type { AgentProcess, AgentRunParams } from "./agents/agent-process.js";

/**
 * docs/125 — Codex registers the review bridge via `[mcp_servers.*]` in
 * config.toml (not a per-run path like Claude). These tests cover the worker's
 * config writer in isolation: it must append a managed block, be idempotent,
 * and never clobber a user's existing config.
 */
describe("SessionWorker.ensureCodexReviewMcpConfig (docs/125)", () => {
  let codexHome: string;
  let worker: SessionWorker;
  const prevHome = process.env.CODEX_HOME;

  beforeEach(() => {
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    process.env.CODEX_HOME = codexHome;
    worker = new SessionWorker({
      agentFactory: () => ({ agentId: "codex" }) as unknown as AgentProcess,
    });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  function ensure(params?: AgentRunParams): Record<string, string> | undefined {
    if (params) {
      return (worker as unknown as { ensureCodexMcpConfig: (params?: AgentRunParams) => Record<string, string> }).ensureCodexMcpConfig(params);
    }
    (worker as unknown as { ensureCodexReviewMcpConfig: () => void }).ensureCodexReviewMcpConfig();
    return undefined;
  }

  const configText = (): string => fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8");

  it("appends a managed [mcp_servers.shipit-review] block pointing at the bridge", () => {
    ensure();
    const cfg = configText();
    expect(cfg).toContain("[mcp_servers.shipit-review]");
    expect(cfg).toContain("mcp-review-bridge.ts");
    expect(cfg).toMatch(/command = ".+tsx"/);
  });

  it("is idempotent — repeat calls do not duplicate the block", () => {
    ensure();
    ensure();
    const occurrences = configText().split("[mcp_servers.shipit-review]").length - 1;
    expect(occurrences).toBe(1);
  });

  it("preserves a user's pre-existing config (append, not clobber)", () => {
    const existing = '[mcp_servers.linear]\ncommand = "linear-mcp"\n';
    fs.writeFileSync(path.join(codexHome, "config.toml"), existing);
    ensure();
    const cfg = configText();
    expect(cfg).toContain("[mcp_servers.linear]");
    expect(cfg).toContain("[mcp_servers.shipit-review]");
  });

  it("writes enabled stdio MCP servers for Codex without persisting env secrets", () => {
    process.env.mcp__linear__LINEAR_API_KEY = "lin_secret";
    try {
      const runtimeEnv = ensure({
        prompt: "hello",
        cwd: "/workspace",
        mcpServers: [{
          name: "linear",
          type: "stdio",
          command: "npx",
          args: ["-y", "@linear/mcp-server"],
          env: { LINEAR_API_KEY: "$secret:mcp__linear__LINEAR_API_KEY" },
          enabled: true,
        }],
      });

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
      const runtimeEnv = ensure({
        prompt: "hello",
        cwd: "/workspace",
        mcpServers: [{
          name: "notion",
          type: "http",
          url: "https://mcp.notion.com/mcp",
          headers: { Authorization: "Bearer $platform:notion_oauth" },
          enabled: true,
        }],
      });

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

  it("replaces the managed Codex MCP block so removed servers do not linger", () => {
    ensure({
      prompt: "hello",
      cwd: "/workspace",
      mcpServers: [{
        name: "linear",
        type: "stdio",
        command: "linear-mcp",
        enabled: true,
      }],
    });
    ensure({ prompt: "hello again", cwd: "/workspace", mcpServers: [] });

    const cfg = configText();
    expect(cfg).not.toContain("[mcp_servers.linear]");
    expect(cfg).toContain("[mcp_servers.shipit-review]");
  });
});
