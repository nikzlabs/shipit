import { describe, expect, it } from "vitest";
import { mcpServerNameError, parseServiceMcpPath, serviceMcpUrl } from "./service-mcp.js";

describe("service MCP declarations (docs/327)", () => {
  it.each(["verseshot", "verseshot-dev", "dev_api", "A1"])("accepts the name %s", (name) => {
    expect(mcpServerNameError(name)).toBeNull();
  });

  it.each([
    ["verse.shot", "letters, digits"],
    ["-dash", "letters, digits"],
    ["Shipit", "always gives the agent"],
    ["playwright", "always gives the agent"],
  ])("refuses the name %s", (name, reason) => {
    expect(mcpServerNameError(name)).toContain(reason);
  });

  it("defaults the path to /mcp and keeps a declared one", () => {
    expect(parseServiceMcpPath(undefined, "mcp.path")).toBe("/mcp");
    expect(parseServiceMcpPath(" /api/mcp ", "mcp.path")).toBe("/api/mcp");
  });

  it.each(["mcp", "/mcp?x=1", "/a b", 42])("refuses the path %s, naming the field", (raw) => {
    expect(parseServiceMcpPath(raw, "mcp.dev.path")).toEqual({ error: expect.stringContaining("`mcp.dev.path`") });
  });

  it("builds the URL the session network resolves", () => {
    expect(serviceMcpUrl("verseshot", 8787, "/mcp")).toBe("http://verseshot:8787/mcp");
  });
});
