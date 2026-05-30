import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  parseShipitConfig,
  resolveShipitConfig,
  ShipitConfigError,
  AGENT_DEFAULTS,
} from "./shipit-config.js";

// ---------------------------------------------------------------------------
// parseShipitConfig (unit tests — no filesystem)
// ---------------------------------------------------------------------------

describe("parseShipitConfig", () => {
  it("returns defaults for null/undefined input", () => {
    const config = parseShipitConfig(null);
    expect(config.agent).toEqual(AGENT_DEFAULTS);
    expect(config.compose).toBeUndefined();
    expect(config.warnings).toEqual([]);
  });

  it("returns defaults for empty object", () => {
    const config = parseShipitConfig({});
    expect(config.agent).toEqual(AGENT_DEFAULTS);
    expect(config.compose).toBeUndefined();
  });

  it("throws for non-object input", () => {
    expect(() => parseShipitConfig("a string")).toThrow(ShipitConfigError);
    expect(() => parseShipitConfig(42)).toThrow(ShipitConfigError);
    expect(() => parseShipitConfig([1, 2])).toThrow(ShipitConfigError);
  });

  // ---- version ----

  it("parses valid version", () => {
    const config = parseShipitConfig({ version: 1 });
    expect(config.version).toBe(1);
  });

  it("throws for non-integer version", () => {
    expect(() => parseShipitConfig({ version: 1.5 })).toThrow("`version` must be a positive integer");
  });

  it("throws for negative version", () => {
    expect(() => parseShipitConfig({ version: -1 })).toThrow("`version` must be a positive integer");
  });

  it("throws for string version", () => {
    expect(() => parseShipitConfig({ version: "1" })).toThrow("`version` must be a positive integer");
  });

  // ---- agent ----

  it("parses agent config with all fields", () => {
    const config = parseShipitConfig({
      agent: { memory: 2048, cpu: 2.0, pids: 512, install: ["npm install"] },
    });
    expect(config.agent).toEqual({ memory: 2048, cpu: 2.0, pids: 512, install: ["npm install"] });
  });

  it("uses defaults for missing agent fields", () => {
    const config = parseShipitConfig({ agent: { memory: 2048 } });
    expect(config.agent.memory).toBe(2048);
    expect(config.agent.cpu).toBe(AGENT_DEFAULTS.cpu);
    expect(config.agent.pids).toBe(AGENT_DEFAULTS.pids);
    expect(config.agent.install).toEqual([]);
  });

  it("uses defaults for invalid resource values", () => {
    const config = parseShipitConfig({ agent: { memory: "lots", cpu: -1, pids: 0 } });
    expect(config.agent.memory).toBe(AGENT_DEFAULTS.memory);
    expect(config.agent.cpu).toBe(AGENT_DEFAULTS.cpu);
    expect(config.agent.pids).toBe(AGENT_DEFAULTS.pids);
  });

  it("floors fractional memory and pids", () => {
    const config = parseShipitConfig({ agent: { memory: 2048.7, pids: 512.9 } });
    expect(config.agent.memory).toBe(2048);
    expect(config.agent.pids).toBe(512);
  });

  it("allows fractional cpu", () => {
    const config = parseShipitConfig({ agent: { cpu: 1.5 } });
    expect(config.agent.cpu).toBe(1.5);
  });

  it("throws for non-object agent", () => {
    expect(() => parseShipitConfig({ agent: "bad" })).toThrow("`agent` must be a mapping");
  });

  // ---- agent.install ----

  it("parses string install as single-element array", () => {
    const config = parseShipitConfig({ agent: { install: "npm install" } });
    expect(config.agent.install).toEqual(["npm install"]);
  });

  it("parses array install", () => {
    const config = parseShipitConfig({
      agent: { install: ["npm install", "npx prisma generate"] },
    });
    expect(config.agent.install).toEqual(["npm install", "npx prisma generate"]);
  });

  it("filters empty strings from install array", () => {
    const config = parseShipitConfig({ agent: { install: ["npm install", "", "  "] } });
    expect(config.agent.install).toEqual(["npm install"]);
  });

  it("returns empty array for empty string install", () => {
    const config = parseShipitConfig({ agent: { install: "" } });
    expect(config.agent.install).toEqual([]);
  });

  it("throws for non-string array entries in install", () => {
    expect(() => parseShipitConfig({ agent: { install: [42] } })).toThrow("must be a string");
  });

  it("throws for invalid install type", () => {
    expect(() => parseShipitConfig({ agent: { install: 42 } })).toThrow("must be a string or array");
  });

  // ---- compose (string form) ----

  it("parses compose as string", () => {
    const config = parseShipitConfig({ compose: "docker-compose.yml" });
    expect(config.compose).toEqual({ file: "docker-compose.yml", dockerSocket: false });
  });

  it("throws for empty compose string", () => {
    expect(() => parseShipitConfig({ compose: "" })).toThrow("must not be empty");
  });

  it("trims compose string", () => {
    const config = parseShipitConfig({ compose: "  docker-compose.yml  " });
    expect(config.compose!.file).toBe("docker-compose.yml");
  });

  // ---- compose (object form) ----

  it("parses compose as object", () => {
    const config = parseShipitConfig({
      compose: { file: "docker-compose.yml", "docker-socket": true },
    });
    expect(config.compose).toEqual({ file: "docker-compose.yml", dockerSocket: true });
  });

  it("defaults docker-socket to false", () => {
    const config = parseShipitConfig({ compose: { file: "compose.yml" } });
    expect(config.compose!.dockerSocket).toBe(false);
  });

  it("throws for missing file in compose object", () => {
    expect(() => parseShipitConfig({ compose: { "docker-socket": true } })).toThrow("`compose.file` is required");
  });

  it("throws for empty file in compose object", () => {
    expect(() => parseShipitConfig({ compose: { file: "" } })).toThrow("`compose.file` is required");
  });

  it("throws for invalid compose type", () => {
    expect(() => parseShipitConfig({ compose: 42 })).toThrow("must be a string or object");
  });

  // ---- warnings for old-format keys ----

  it("warns for preview key", () => {
    const config = parseShipitConfig({ preview: { command: "npm run dev" } });
    expect(config.warnings).toContainEqual(expect.stringContaining("`preview` block has been removed"));
  });

  it("warns for resources key", () => {
    const config = parseShipitConfig({ resources: { agent: { memory: 2048 } } });
    expect(config.warnings).toContainEqual(expect.stringContaining("`resources` block has been replaced"));
  });

  it("warns for capabilities key", () => {
    const config = parseShipitConfig({ capabilities: { docker: true } });
    expect(config.warnings).toContainEqual(expect.stringContaining("`capabilities` block has been replaced"));
  });

  it("warns for services key", () => {
    const config = parseShipitConfig({ services: {} });
    expect(config.warnings).toContainEqual(expect.stringContaining("`services` block has been removed"));
  });

  it("warns for top-level install key", () => {
    const config = parseShipitConfig({ install: "npm install" });
    expect(config.warnings).toContainEqual(expect.stringContaining("`install` field has moved"));
  });

  it("warns for unknown top-level keys", () => {
    const config = parseShipitConfig({ agent: {}, foobar: true });
    expect(config.warnings).toContainEqual(expect.stringContaining("Unknown top-level key `foobar`"));
  });

  it("warns for unknown agent keys", () => {
    const config = parseShipitConfig({ agent: { memory: 1024, unknown_field: true } });
    expect(config.warnings).toContainEqual(expect.stringContaining("Unknown key `agent.unknown_field`"));
  });

  // ---- full config ----

  it("parses a complete config", () => {
    const config = parseShipitConfig({
      version: 1,
      agent: {
        memory: 3072,
        cpu: 2.0,
        pids: 2048,
        install: ["npm install", "npx prisma generate"],
      },
      compose: {
        file: "docker/local/dev/compose.yml",
        "docker-socket": true,
      },
    });
    expect(config.version).toBe(1);
    expect(config.agent).toEqual({
      memory: 3072,
      cpu: 2.0,
      pids: 2048,
      install: ["npm install", "npx prisma generate"],
    });
    expect(config.compose).toEqual({
      file: "docker/local/dev/compose.yml",
      dockerSocket: true,
    });
    expect(config.warnings).toEqual([]);
  });

  // ---- x-shipit-host-mounts (docs/128) ----

  it("defaults host mounts to empty array", () => {
    const config = parseShipitConfig({});
    expect(config.hostMounts).toEqual([]);
  });

  it("parses allow-listed host mounts as read-only", () => {
    const config = parseShipitConfig({
      "x-shipit-host-mounts": ["/var/log/journal", "/run/log/journal"],
    });
    expect(config.hostMounts).toEqual([
      { source: "/var/log/journal", target: "/var/log/journal", readOnly: true },
      { source: "/run/log/journal", target: "/run/log/journal", readOnly: true },
    ]);
    expect(config.warnings).toEqual([]);
  });

  it("de-duplicates repeated host mounts", () => {
    const config = parseShipitConfig({
      "x-shipit-host-mounts": ["/var/log/journal", "/var/log/journal"],
    });
    expect(config.hostMounts).toEqual([
      { source: "/var/log/journal", target: "/var/log/journal", readOnly: true },
    ]);
  });

  it("rejects host mounts outside the allow-list", () => {
    expect(() => parseShipitConfig({ "x-shipit-host-mounts": ["/etc"] })).toThrow(ShipitConfigError);
    expect(() => parseShipitConfig({ "x-shipit-host-mounts": ["/root/.ssh"] })).toThrow(
      "is not allowed",
    );
    expect(() => parseShipitConfig({ "x-shipit-host-mounts": ["/var/lib/docker"] })).toThrow(
      ShipitConfigError,
    );
  });

  it("rejects a non-list host-mounts value", () => {
    expect(() => parseShipitConfig({ "x-shipit-host-mounts": "/var/log/journal" })).toThrow(
      "must be a list",
    );
  });

  it("rejects non-string host-mount entries", () => {
    expect(() => parseShipitConfig({ "x-shipit-host-mounts": [42] })).toThrow(ShipitConfigError);
  });

  it("does not warn on the x-shipit-host-mounts top-level key", () => {
    const config = parseShipitConfig({ "x-shipit-host-mounts": ["/var/log/journal"] });
    expect(config.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveShipitConfig (filesystem tests)
// ---------------------------------------------------------------------------

describe("resolveShipitConfig", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-config-"));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns defaults when shipit.yaml does not exist", () => {
    const dir = setup();
    const config = resolveShipitConfig(dir);
    expect(config.agent).toEqual(AGENT_DEFAULTS);
    expect(config.compose).toBeUndefined();
    expect(config.warnings).toEqual([]);
  });

  it("parses shipit.yaml from filesystem", () => {
    const dir = setup();
    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      "agent:\n  memory: 2048\n  install: npm install\ncompose: docker-compose.yml\n",
    );
    const config = resolveShipitConfig(dir);
    expect(config.agent.memory).toBe(2048);
    expect(config.agent.install).toEqual(["npm install"]);
    expect(config.compose).toEqual({ file: "docker-compose.yml", dockerSocket: false });
  });

  it("does not auto-detect compose files", () => {
    const dir = setup();
    fs.writeFileSync(path.join(dir, "shipit.yaml"), "agent:\n  memory: 2048\n");
    fs.writeFileSync(path.join(dir, "docker-compose.yml"), "services: {}\n");
    const config = resolveShipitConfig(dir);
    expect(config.compose).toBeUndefined();
  });

  it("returns undefined compose when not specified", () => {
    const dir = setup();
    fs.writeFileSync(path.join(dir, "shipit.yaml"), "agent:\n  memory: 2048\n");
    const config = resolveShipitConfig(dir);
    expect(config.compose).toBeUndefined();
  });

  it("propagates ShipitConfigError", () => {
    const dir = setup();
    fs.writeFileSync(path.join(dir, "shipit.yaml"), "agent: bad_value\n");
    expect(() => resolveShipitConfig(dir)).toThrow(ShipitConfigError);
  });

  it("handles empty shipit.yaml", () => {
    const dir = setup();
    fs.writeFileSync(path.join(dir, "shipit.yaml"), "");
    const config = resolveShipitConfig(dir);
    expect(config.agent).toEqual(AGENT_DEFAULTS);
  });

  it("emits warnings for old-format keys from filesystem", () => {
    const dir = setup();
    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      "preview:\n  command: npm run dev\nresources:\n  agent:\n    memory: 2048\n",
    );
    const config = resolveShipitConfig(dir);
    expect(config.warnings.length).toBeGreaterThanOrEqual(2);
  });
});
