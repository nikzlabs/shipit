import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexAdapter } from "./adapter.js";
import type { AgentMcpBridge, McpServerConfig } from "../agent-process.js";

/**
 * docs/125 / docs/155 hair 10 / SHI-128 — Codex registers its MCP servers via a
 * `[mcp_servers.*]` block in `~/.codex/config.toml`, not a per-run path like
 * Claude. These tests cover CodexAdapter.writeMcpConfig() in isolation:
 *  - it appends the ShipIt-managed block (one consolidated `shipit` bridge +
 *    user servers),
 *  - the `shipit` server selects Codex's tool subset via `SHIPIT_MCP_TOOLS`,
 *    passed through runtimeEnv and allowlisted with `env_vars`,
 *  - it's idempotent across repeat calls,
 *  - it never clobbers a user's own config outside the managed block,
 *  - secrets in stdio `env` / HTTP `headers` arrive via runtimeEnv (env
 *    indirection) so the .toml never persists raw secret values.
 *
 * The test stubs `hasFileAuth` so the adapter constructor stays cheap (no
 * filesystem checks); writeMcpConfig() doesn't depend on the spawn path.
 */
describe("CodexAdapter.writeMcpConfig (docs/125, docs/155 hair 10, SHI-128)", () => {
  let codexHome: string;
  let adapter: CodexAdapter;
  const prevHome = process.env.CODEX_HOME;
  const shipitBridge: AgentMcpBridge = {
    tsxBin: "/opt/node",
    bridgePath: "/opt/dist/mcp-bridges/mcp-shipit-bridge.js",
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
    bridge: AgentMcpBridge | null = shipitBridge,
  ): Record<string, string> | undefined {
    return adapter.writeMcpConfig({
      servers,
      shipitBridge: bridge,
      onServerFailed,
    }).runtimeEnv;
  }

  const configText = (): string => fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8");

  it("always emits the built-in playwright browser server (docs/079)", () => {
    // Codex previously shipped without Playwright even though the shared system
    // prompt advertises a browser; this guards against that regression.
    write([], null);
    const cfg = configText();
    expect(cfg).toContain("[mcp_servers.playwright]");
    expect(cfg).toContain("--browser chromium");
  });

  // SHI-#1558 — Codex spawns MCP servers with a controlled env, so the
  // pre-installed browser path (PLAYWRIGHT_BROWSERS_PATH) must be forwarded via
  // env_vars + runtimeEnv or every browser_* tool fails with
  // `Browser "chrome-for-testing" is not installed`. Claude's children inherit
  // the worker env so it never needed this; Codex does.
  it("forwards PLAYWRIGHT_BROWSERS_PATH to the playwright MCP server (SHI-#1558)", () => {
    const prev = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = "/opt/playwright-browsers";
    try {
      const runtimeEnv = write([], null);
      const cfg = configText();
      expect(cfg).toContain('env_vars = ["PLAYWRIGHT_BROWSERS_PATH"]');
      expect(runtimeEnv).toMatchObject({
        PLAYWRIGHT_BROWSERS_PATH: "/opt/playwright-browsers",
      });
    } finally {
      if (prev === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      else process.env.PLAYWRIGHT_BROWSERS_PATH = prev;
    }
  });

  it("omits playwright env_vars when PLAYWRIGHT_BROWSERS_PATH is unset", () => {
    const prev = process.env.PLAYWRIGHT_BROWSERS_PATH;
    delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    try {
      const runtimeEnv = write([], null);
      const cfg = configText();
      // The playwright block is still written; only the env_vars line is gated.
      expect(cfg).toContain("[mcp_servers.playwright]");
      expect(cfg).not.toContain('env_vars = ["PLAYWRIGHT_BROWSERS_PATH"]');
      expect(runtimeEnv?.PLAYWRIGHT_BROWSERS_PATH).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      else process.env.PLAYWRIGHT_BROWSERS_PATH = prev;
    }
  });

  it("appends a single managed [mcp_servers.shipit] block selecting Codex's tool subset", () => {
    const runtimeEnv = write();
    const cfg = configText();
    expect(cfg).toContain("[mcp_servers.shipit]");
    expect(cfg).toContain("mcp-shipit-bridge.js");
    expect(cfg).toMatch(/command = ".+node"/);
    // Tool subset is passed via the child env, allowlisted with env_vars.
    expect(cfg).toContain('env_vars = ["SHIPIT_MCP_TOOLS"]');
    expect(runtimeEnv).toMatchObject({ SHIPIT_MCP_TOOLS: "present,voice,ask,bug,propose_actions" });
    // No per-tool servers remain.
    expect(cfg).not.toContain("[mcp_servers.shipit-review]");
    expect(cfg).not.toContain("[mcp_servers.shipit-ask]");
  });

  it("omits the shipit bridge when no bridge paths are supplied", () => {
    const runtimeEnv = write([], null);
    expect(configText()).not.toContain("[mcp_servers.shipit]");
    expect(runtimeEnv?.SHIPIT_MCP_TOOLS).toBeUndefined();
  });

  it("includes ask (docs/147) in the Codex tool subset but not permission", () => {
    const runtimeEnv = write();
    expect(runtimeEnv?.SHIPIT_MCP_TOOLS).toContain("ask");
    expect(runtimeEnv?.SHIPIT_MCP_TOOLS).not.toContain("permission");
  });

  // docs/207 / SHI-153: propose_actions (action-checklist cards) must be in the
  // Codex tool subset. Codex runs approvalPolicy:"never" so it auto-approves with
  // no allowlist plumbing — this assertion guards against a silent regression
  // mirroring the Claude allowlist omission that broke the tool there.
  it("includes propose_actions (docs/207) in the Codex tool subset", () => {
    const runtimeEnv = write();
    expect(runtimeEnv?.SHIPIT_MCP_TOOLS).toContain("propose_actions");
  });

  it("is idempotent — repeat calls do not duplicate the block", () => {
    write();
    write();
    const occurrences = configText().split("[mcp_servers.shipit]").length - 1;
    expect(occurrences).toBe(1);
  });

  it("preserves a user's pre-existing config (append, not clobber)", () => {
    const existing = '[mcp_servers.linear]\ncommand = "linear-mcp"\n';
    fs.writeFileSync(path.join(codexHome, "config.toml"), existing);
    write();
    const cfg = configText();
    expect(cfg).toContain("[mcp_servers.linear]");
    expect(cfg).toContain("[mcp_servers.shipit]");
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

  it("writes enabled HTTP MCP bearer auth using Codex bearer_token_env_var", () => {
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
      expect(cfg).toContain('bearer_token_env_var = "SHIPIT_MCP_NOTION_BEARER_TOKEN"');
      expect(cfg).not.toContain("env_http_headers");
      expect(cfg).not.toContain("notion_token");
      expect(runtimeEnv).toMatchObject({
        SHIPIT_MCP_NOTION_BEARER_TOKEN: "notion_token",
      });
    } finally {
      delete process.env.MCP_PLATFORM_NOTION_OAUTH;
    }
  });

  it("keeps non-Bearer HTTP MCP headers env-backed", () => {
    process.env.mcp__custom__API_KEY = "custom_secret";
    try {
      const runtimeEnv = write([{
        name: "custom",
        type: "http",
        url: "https://custom.example/mcp",
        headers: { "X-Api-Key": "$secret:mcp__custom__API_KEY" },
        enabled: true,
      }]);

      const cfg = configText();
      expect(cfg).toContain("[mcp_servers.custom]");
      expect(cfg).toContain('url = "https://custom.example/mcp"');
      expect(cfg).toContain('env_http_headers = { "X-Api-Key" = "SHIPIT_MCP_CUSTOM_HTTP_HEADER_0" }');
      expect(cfg).not.toContain("custom_secret");
      expect(runtimeEnv).toMatchObject({
        SHIPIT_MCP_CUSTOM_HTTP_HEADER_0: "custom_secret",
      });
    } finally {
      delete process.env.mcp__custom__API_KEY;
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
    expect(cfg).toContain("[mcp_servers.shipit]");
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
