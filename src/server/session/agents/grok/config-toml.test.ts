/**
 * `renderGrokConfigToml` (docs/274).
 *
 * The reason this file exists is escaping. Everything else here is a shape read
 * off a real `grok mcp add` run and asserted once; the escaping is where a
 * user's own value — an MCP server's `args` or an `env` secret containing a
 * quote or a backslash — silently turns a config into a *different* config
 * rather than a broken one, which is the failure nobody notices.
 */

import { describe, it, expect } from "vitest";
import { renderGrokConfigToml } from "./config-toml.js";

describe("renderGrokConfigToml", () => {
  it("renders a stdio server the way `grok mcp add` writes one", () => {
    const toml = renderGrokConfigToml({
      playwright: { command: "playwright-mcp", args: ["--headless"], enabled: true },
    });
    expect(toml).toContain('[mcp_servers."playwright"]');
    expect(toml).toContain('command = "playwright-mcp"');
    expect(toml).toContain('args = ["--headless"]');
    expect(toml).toContain("enabled = true");
  });

  it("renders a remote server with its transport and headers", () => {
    const toml = renderGrokConfigToml({
      notion: {
        transport: "http",
        url: "https://mcp.notion.com/mcp",
        enabled: true,
        headers: { Authorization: "Bearer abc" },
      },
    });
    expect(toml).toContain('transport = "http"');
    expect(toml).toContain('url = "https://mcp.notion.com/mcp"');
    expect(toml).toContain('[mcp_servers."notion".headers]');
    expect(toml).toContain('"Authorization" = "Bearer abc"');
  });

  it("escapes quotes and backslashes in every position a value can appear", () => {
    const toml = renderGrokConfigToml({
      't"ricky': {
        command: 'C:\\Program Files\\thing.exe',
        args: ['--flag="value"', "back\\slash"],
        env: { 'K"EY': 'v"al\\ue' },
        enabled: true,
      },
    });
    // The server NAME is a value too — an unescaped quote there closes the
    // table header early and the rest of the block lands somewhere else.
    expect(toml).toContain('[mcp_servers."t\\"ricky"]');
    expect(toml).toContain('command = "C:\\\\Program Files\\\\thing.exe"');
    expect(toml).toContain('args = ["--flag=\\"value\\"", "back\\\\slash"]');
    expect(toml).toContain('"K\\"EY" = "v\\"al\\\\ue"');
    // Nothing may escape its own string: every quote in the document is either
    // a delimiter or escaped, so the count stays even.
    const quotes = (toml.match(/(?<!\\)"/g) ?? []).length;
    expect(quotes % 2).toBe(0);
  });

  it("escapes newlines rather than emitting a broken multi-line value", () => {
    const toml = renderGrokConfigToml({
      s: { command: "x", env: { NOTE: "line one\nline two" }, enabled: true },
    });
    expect(toml).toContain('"NOTE" = "line one\\nline two"');
    // A raw newline inside a basic string is a TOML parse error, and would take
    // the whole config — including every other server — with it.
    expect(toml.split("\n").some((l) => l.startsWith("line two"))).toBe(false);
  });

  it("puts nested tables LAST so no scalar lands inside one", () => {
    const toml = renderGrokConfigToml({
      s: { command: "x", args: ["a"], env: { A: "1" }, enabled: true },
    });
    const envHeader = toml.indexOf('[mcp_servers."s".env]');
    // Everything after a `[a.b]` header belongs to that table. `enabled` landing
    // after it would become `mcp_servers.s.env.enabled` — a key the CLI ignores,
    // and a server that is silently off.
    expect(toml.indexOf("enabled = true")).toBeLessThan(envHeader);
    expect(toml.indexOf("args = ")).toBeLessThan(envHeader);
  });

  it("always disables the auto-updater, even with no servers at all", () => {
    const toml = renderGrokConfigToml({});
    expect(toml).toContain("[cli]");
    expect(toml).toContain("auto_update = false");
    expect(toml).not.toContain("mcp_servers");
  });

  it("omits fields that were not supplied rather than writing empty ones", () => {
    const toml = renderGrokConfigToml({ s: { command: "x" } });
    expect(toml).not.toContain("args = ");
    expect(toml).not.toContain("enabled = ");
    expect(toml).not.toContain(".env]");
    expect(toml).not.toContain(".headers]");
  });
});
