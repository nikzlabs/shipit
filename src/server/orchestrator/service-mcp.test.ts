import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectInvalidShipitConfig } from "../shared/shipit-config-test-guard.js";
import type { PluginComposeService } from "./plugin-compose.js";
import { pluginServiceMcpServers, resolveServiceMcpServers } from "./service-mcp.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "service-mcp-"));
});

afterEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

const writeConfig = (body: string): void => {
  fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), body);
};

const plugins = (...servers: { name: string; url: string }[]) => ({ pluginMcpServers: () => servers });

describe("resolveServiceMcpServers (docs/327)", () => {
  it("gives the project's servers, then the plugins'", () => {
    writeConfig("mcp:\n  verseshotdev:\n    service: api\n    port: 8787\n");

    expect(resolveServiceMcpServers(workspaceDir, plugins({ name: "verseshot", url: "http://verseshot:4300/mcp" })))
      .toEqual([
        { name: "verseshotdev", url: "http://api:8787/mcp" },
        { name: "verseshot", url: "http://verseshot:4300/mcp" },
      ]);
  });

  it("lets the project's server win a name over a plugin's", () => {
    writeConfig("mcp:\n  Verseshot:\n    service: api\n    port: 8787\n    path: /v1\n");

    expect(resolveServiceMcpServers(workspaceDir, plugins({ name: "verseshot", url: "http://verseshot:4300/mcp" })))
      .toEqual([{ name: "Verseshot", url: "http://api:8787/v1" }]);
  });

  it("is empty for a session with no shipit.yaml and no service manager", () => {
    expect(resolveServiceMcpServers(workspaceDir, null)).toEqual([]);
  });

  it("is null while shipit.yaml cannot be parsed, so a resident keeps its servers", () => {
    expectInvalidShipitConfig(() => writeConfig("compose: {}\n"));
    expect(resolveServiceMcpServers(workspaceDir, plugins())).toBeNull();
  });
});

describe("pluginServiceMcpServers (docs/327)", () => {
  const service = (over: Partial<PluginComposeService>): PluginComposeService => ({
    name: "verseshot",
    sourceName: "verseshot",
    alias: "verseshot",
    repo: "tools",
    plugin: "verseshot",
    preview: "auto",
    definition: {},
    credentials: [],
    externalVolumes: [],
    self: false,
    ...over,
  });

  it("reaches a plugin's server by the service's compose name and the consumer's port", () => {
    expect(pluginServiceMcpServers([
      service({ name: "verse-api", port: 4300, mcp: { name: "verseshot", path: "/mcp" } }),
      service({ name: "worker" }),
    ])).toEqual([{ name: "verseshot", url: "http://verse-api:4300/mcp" }]);
  });

  it("gives nothing for a service without a port", () => {
    expect(pluginServiceMcpServers([service({ mcp: { name: "verseshot", path: "/mcp" } })])).toEqual([]);
  });
});
