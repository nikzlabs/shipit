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
    expect(toml).toContain('[mcp_servers."t\\"ricky"]');
    expect(toml).toContain('command = "C:\\\\Program Files\\\\thing.exe"');
    expect(toml).toContain('args = ["--flag=\\"value\\"", "back\\\\slash"]');
    expect(toml).toContain('"K\\"EY" = "v\\"al\\\\ue"');
    const quotes = (toml.match(/(?<!\\)"/g) ?? []).length;
    expect(quotes % 2).toBe(0);
  });

  it("escapes newlines rather than emitting a broken multi-line value", () => {
    const toml = renderGrokConfigToml({
      s: { command: "x", env: { NOTE: "line one\nline two" }, enabled: true },
    });
    expect(toml).toContain('"NOTE" = "line one\\nline two"');
    expect(toml.split("\n").some((l) => l.startsWith("line two"))).toBe(false);
  });

  it("puts nested tables LAST so no scalar lands inside one", () => {
    const toml = renderGrokConfigToml({
      s: { command: "x", args: ["a"], env: { A: "1" }, enabled: true },
    });
    const envHeader = toml.indexOf('[mcp_servers."s".env]');
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
