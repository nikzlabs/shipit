/**
 * Unit tests for the pure MCP `$secret:` resolver (docs/088).
 *
 * Verifies the substring-substitution contract: walks `env` / `headers` /
 * `args`, replaces `$secret:KEY` with `env[KEY]`, drops the entire server
 * if any referenced key is missing or empty.
 */

import { describe, it, expect } from "vitest";
import { resolveMcpServer, substituteMcpPlaceholders } from "./mcp-resolve.js";
import type { McpServerConfig } from "./agents/agent-process.js";

describe("resolveMcpServer (docs/088)", () => {
  const stdioConfig: McpServerConfig = {
    name: "linear",
    type: "stdio",
    command: "npx",
    args: ["-y", "@anthropic-ai/linear-mcp"],
    env: { LINEAR_API_KEY: "$secret:mcp__linear__LINEAR_API_KEY" },
    enabled: true,
  };

  const httpConfig: McpServerConfig = {
    name: "linear",
    type: "http",
    url: "https://mcp.linear.app/mcp",
    headers: { Authorization: "Bearer $secret:mcp__linear__TOKEN" },
    enabled: true,
  };

  it("substitutes $secret:KEY in stdio env against the provided env map", () => {
    const env = { mcp__linear__LINEAR_API_KEY: "lin_api_abc123" };
    const { resolved, missing } = resolveMcpServer(stdioConfig, env);
    expect(missing).toEqual([]);
    expect(resolved).toEqual({
      command: "npx",
      args: ["-y", "@anthropic-ai/linear-mcp"],
      env: { LINEAR_API_KEY: "lin_api_abc123" },
    });
  });

  it("substring-substitutes in headers, preserving the literal Bearer prefix", () => {
    const env = { mcp__linear__TOKEN: "lin_oauth_xyz" };
    const { resolved, missing } = resolveMcpServer(httpConfig, env);
    expect(missing).toEqual([]);
    expect(resolved).toEqual({
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer lin_oauth_xyz" },
    });
  });

  it("drops the server and reports missing keys when env is empty", () => {
    const { resolved, missing } = resolveMcpServer(stdioConfig, {});
    expect(resolved).toBeNull();
    expect(missing).toEqual(["mcp__linear__LINEAR_API_KEY"]);
  });

  it("treats empty-string env values as missing", () => {
    const env = { mcp__linear__LINEAR_API_KEY: "" };
    const { resolved, missing } = resolveMcpServer(stdioConfig, env);
    expect(resolved).toBeNull();
    expect(missing).toEqual(["mcp__linear__LINEAR_API_KEY"]);
  });

  it("treats undefined env values as missing", () => {
    const env: Record<string, string | undefined> = {
      mcp__linear__LINEAR_API_KEY: undefined,
    };
    const { resolved, missing } = resolveMcpServer(stdioConfig, env);
    expect(resolved).toBeNull();
    expect(missing).toEqual(["mcp__linear__LINEAR_API_KEY"]);
  });

  it("collects all missing keys and dedupes when the same key is referenced twice", () => {
    const config: McpServerConfig = {
      name: "x",
      type: "stdio",
      command: "/usr/bin/x",
      args: ["--token", "$secret:TOKEN", "--key", "$secret:TOKEN"],
      env: { OTHER: "$secret:OTHER" },
      enabled: true,
    };
    const { resolved, missing } = resolveMcpServer(config, {});
    expect(resolved).toBeNull();
    expect([...missing].sort()).toEqual(["OTHER", "TOKEN"]);
  });

  it("substitutes inside args (stdio)", () => {
    const config: McpServerConfig = {
      name: "x",
      type: "stdio",
      command: "/usr/bin/x",
      args: ["--token=$secret:TOKEN"],
      enabled: true,
    };
    const { resolved, missing } = resolveMcpServer(config, { TOKEN: "abc" });
    expect(missing).toEqual([]);
    expect(resolved).toEqual({
      command: "/usr/bin/x",
      args: ["--token=abc"],
    });
  });

  it("leaves literal values untouched (no $secret: placeholder)", () => {
    const config: McpServerConfig = {
      name: "x",
      type: "stdio",
      command: "/usr/bin/x",
      env: { PLAIN_VALUE: "literal-no-placeholder" },
      enabled: true,
    };
    const { resolved, missing } = resolveMcpServer(config, {});
    expect(missing).toEqual([]);
    expect(resolved).toEqual({
      command: "/usr/bin/x",
      env: { PLAIN_VALUE: "literal-no-placeholder" },
    });
  });

  it("handles stdio config without env or args", () => {
    const config: McpServerConfig = {
      name: "x",
      type: "stdio",
      command: "/usr/bin/x",
      enabled: true,
    };
    const { resolved, missing } = resolveMcpServer(config, {});
    expect(missing).toEqual([]);
    expect(resolved).toEqual({ command: "/usr/bin/x" });
  });

  it("handles http config without headers", () => {
    const config: McpServerConfig = {
      name: "x",
      type: "http",
      url: "https://example.com/mcp",
      enabled: true,
    };
    const { resolved, missing } = resolveMcpServer(config, {});
    expect(missing).toEqual([]);
    expect(resolved).toEqual({ type: "http", url: "https://example.com/mcp" });
  });

  it("supports multiple placeholders in a single value", () => {
    const config: McpServerConfig = {
      name: "x",
      type: "http",
      url: "https://example.com/mcp",
      headers: { Auth: "Bearer $secret:A:$secret:B" },
      enabled: true,
    };
    const { resolved, missing } = resolveMcpServer(config, { A: "alpha", B: "beta" });
    expect(missing).toEqual([]);
    expect(resolved).toMatchObject({
      headers: { Auth: "Bearer alpha:beta" },
    });
  });

  describe("$platform: placeholders (docs/088 Phase 2)", () => {
    it("resolves $platform:linear_oauth against MCP_PLATFORM_LINEAR_OAUTH", () => {
      const config: McpServerConfig = {
        name: "linear",
        type: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer $platform:linear_oauth" },
        enabled: true,
      };
      const { resolved, missing } = resolveMcpServer(config, {
        MCP_PLATFORM_LINEAR_OAUTH: "lin_oauth_xyz",
      });
      expect(missing).toEqual([]);
      expect(resolved).toEqual({
        type: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer lin_oauth_xyz" },
      });
    });

    it("drops the server and reports MCP_PLATFORM_<UPPER> missing when env empty", () => {
      const config: McpServerConfig = {
        name: "notion",
        type: "http",
        url: "https://mcp.notion.com/mcp",
        headers: { Authorization: "Bearer $platform:notion_oauth" },
        enabled: true,
      };
      const { resolved, missing } = resolveMcpServer(config, {});
      expect(resolved).toBeNull();
      expect(missing).toEqual(["MCP_PLATFORM_NOTION_OAUTH"]);
    });

    it("mixes $secret: and $platform: in the same value", () => {
      const config: McpServerConfig = {
        name: "x",
        type: "http",
        url: "https://example.com/mcp",
        headers: {
          Authorization: "Bearer $platform:linear_oauth",
          "X-Extra": "scheme=$secret:mcp__x__SCHEME",
        },
        enabled: true,
      };
      const { resolved, missing } = resolveMcpServer(config, {
        MCP_PLATFORM_LINEAR_OAUTH: "lin_xyz",
        mcp__x__SCHEME: "abc",
      });
      expect(missing).toEqual([]);
      expect(resolved).toMatchObject({
        headers: {
          Authorization: "Bearer lin_xyz",
          "X-Extra": "scheme=abc",
        },
      });
    });

    it("rejects $platform: identifiers with uppercase or invalid characters", () => {
      // $platform: ids must match /[a-z][a-z0-9_]*/. Anything else isn't a
      // valid placeholder and is left as a literal — there's no way the user
      // could have stored tokens under those source ids anyway.
      const config: McpServerConfig = {
        name: "x",
        type: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer $platform:LINEAR_OAUTH" },
        enabled: true,
      };
      const { resolved, missing } = resolveMcpServer(config, {});
      // No placeholders matched → no substitutions, no missing reports.
      expect(missing).toEqual([]);
      expect(resolved).toEqual({
        type: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer $platform:LINEAR_OAUTH" },
      });
    });
  });
});

// The connectivity-test path (worker `/mcp/test`) shares this helper so it
// can't drift from the agent's resolver — the bug it fixes was a duplicate
// secret-only resolver that left `$platform:` literals in the auth header.
describe("substituteMcpPlaceholders (shared by agent + test paths)", () => {
  it("substitutes both $secret: and $platform: in one string", () => {
    const missing: string[] = [];
    const out = substituteMcpPlaceholders(
      "Bearer $platform:notion_oauth / $secret:mcp__x__K",
      { MCP_PLATFORM_NOTION_OAUTH: "ntn_tok", mcp__x__K: "sk_val" },
      missing,
    );
    expect(out).toBe("Bearer ntn_tok / sk_val");
    expect(missing).toEqual([]);
  });

  it("maps $platform:<source> to MCP_PLATFORM_<UPPER>", () => {
    const missing: string[] = [];
    const out = substituteMcpPlaceholders(
      "Bearer $platform:notion_oauth",
      { MCP_PLATFORM_NOTION_OAUTH: "ntn_tok" },
      missing,
    );
    expect(out).toBe("Bearer ntn_tok");
    expect(missing).toEqual([]);
  });

  it("records the MCP_PLATFORM_* env name when an OAuth token is missing", () => {
    const missing: string[] = [];
    const out = substituteMcpPlaceholders("Bearer $platform:notion_oauth", {}, missing);
    expect(out).toBe("Bearer ");
    expect(missing).toEqual(["MCP_PLATFORM_NOTION_OAUTH"]);
  });
});
