import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as parseYaml } from "yaml";
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

  it("parses agent config fields", () => {
    const config = parseShipitConfig({
      agent: { install: ["npm install"] },
    });
    expect(config.agent).toEqual({
      install: ["npm install"],
      depDirs: ["node_modules"],
      installInputs: null,
    });
  });

  it("warns-and-ignores removed resource fields (memory/cpu/pids — docs/229)", () => {
    const config = parseShipitConfig({ agent: { memory: 2048, cpu: 2.0, pids: 512 } });
    // Fields are not on AgentConfig anymore — sizing is automatic.
    expect(config.agent).toEqual({ ...AGENT_DEFAULTS, install: [] });
    expect(config.warnings).toContainEqual(expect.stringContaining("`agent.memory` is no longer used"));
    expect(config.warnings).toContainEqual(expect.stringContaining("`agent.cpu` is no longer used"));
    expect(config.warnings).toContainEqual(expect.stringContaining("`agent.pids` is no longer used"));
  });

  it("does not treat removed resource keys as generic unknown keys", () => {
    const config = parseShipitConfig({ agent: { memory: 2048 } });
    expect(config.warnings).not.toContainEqual(expect.stringContaining("Unknown key `agent.memory`"));
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

  // ---- agent.dep-dirs (docs/183) ----

  it("defaults dep-dirs to [node_modules] when absent", () => {
    expect(parseShipitConfig({}).agent.depDirs).toEqual(["node_modules"]);
    expect(parseShipitConfig({ agent: { memory: 2048 } }).agent.depDirs).toEqual(["node_modules"]);
  });

  it("parses a string dep-dirs as a single-element list", () => {
    const config = parseShipitConfig({ agent: { "dep-dirs": "node_modules" } });
    expect(config.agent.depDirs).toEqual(["node_modules"]);
    expect(config.warnings).toEqual([]);
  });

  it("parses multiple dep-dirs and normalizes them", () => {
    const config = parseShipitConfig({
      agent: { "dep-dirs": ["node_modules", "./packages/app/node_modules", "vendor/bundle/"] },
    });
    expect(config.agent.depDirs).toEqual([
      "node_modules",
      "packages/app/node_modules",
      "vendor/bundle",
    ]);
    expect(config.warnings).toEqual([]);
  });

  it("de-duplicates dep-dirs after normalization", () => {
    const config = parseShipitConfig({
      agent: { "dep-dirs": ["node_modules", "./node_modules", "node_modules/"] },
    });
    expect(config.agent.depDirs).toEqual(["node_modules"]);
  });

  it("treats an explicit empty dep-dirs list as opt-out (no overlay dirs)", () => {
    const config = parseShipitConfig({ agent: { "dep-dirs": [] } });
    expect(config.agent.depDirs).toEqual([]);
    expect(config.warnings).toEqual([]);
  });

  it("drops absolute, glob, dot-dot, and root dep-dirs with a warning, keeping the valid ones", () => {
    const config = parseShipitConfig({
      agent: {
        "dep-dirs": [
          "node_modules", // valid
          "/abs/node_modules", // absolute → dropped
          "packages/*/node_modules", // glob → dropped
          "../escape", // .. → dropped
          ".", // root → dropped
          "  ", // empty → dropped
          42, // non-string → dropped
        ],
      },
    });
    expect(config.agent.depDirs).toEqual(["node_modules"]);
    // One warning per dropped entry (6 dropped).
    expect(config.warnings.filter((w) => w.includes("agent.dep-dirs["))).toHaveLength(6);
  });

  it("falls back to the default for a wrong-typed dep-dirs value, with a warning", () => {
    const config = parseShipitConfig({ agent: { "dep-dirs": 42 } });
    expect(config.agent.depDirs).toEqual(["node_modules"]);
    expect(config.warnings).toContain(
      "`agent.dep-dirs` must be a string or a list of strings; using the default [node_modules].",
    );
  });

  // ---- agent.install-inputs (docs/197) ----

  it("defaults install-inputs to null (not configured → command-derived) when absent", () => {
    expect(parseShipitConfig({}).agent.installInputs).toBeNull();
    expect(parseShipitConfig({ agent: { memory: 2048 } }).agent.installInputs).toBeNull();
  });

  it("parses a string install-inputs as a single-element list", () => {
    const config = parseShipitConfig({ agent: { "install-inputs": "requirements.txt" } });
    expect(config.agent.installInputs).toEqual(["requirements.txt"]);
  });

  it("parses + normalizes + de-duplicates an install-inputs list", () => {
    const config = parseShipitConfig({
      agent: { "install-inputs": ["package.json", "./prisma/schema.prisma", "package.json"] },
    });
    expect(config.agent.installInputs).toEqual(["package.json", "prisma/schema.prisma"]);
  });

  it("treats an explicit empty install-inputs list as an override (content-keying off)", () => {
    const config = parseShipitConfig({ agent: { "install-inputs": [] } });
    expect(config.agent.installInputs).toEqual([]);
  });

  it("drops absolute / glob / dot-dot / root install-inputs entries with a warning", () => {
    const config = parseShipitConfig({
      agent: {
        "install-inputs": ["/abs.txt", "deps/*.txt", "../escape.txt", ".", "package.json"],
      },
    });
    expect(config.agent.installInputs).toEqual(["package.json"]);
    expect(config.warnings.filter((w) => w.includes("agent.install-inputs["))).toHaveLength(4);
  });

  it("falls back to null (not configured) for a wrong-typed install-inputs value, with a warning", () => {
    const config = parseShipitConfig({ agent: { "install-inputs": 42 } });
    expect(config.agent.installInputs).toBeNull();
    expect(config.warnings).toContain(
      "`agent.install-inputs` must be a string or a list of strings; ignoring it.",
    );
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
    expect(config.warnings).toContainEqual(expect.stringContaining("`resources` block has been removed"));
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

  it("does not warn for the reserved plugin-repository keys (docs/262)", () => {
    // `plugins:` (consumer declaration) and `exports:` (plugin manifest) are
    // reserved ahead of their slice-2 parser so the live test-plugin fixture in
    // this repo's own shipit.yaml doesn't trip the migration banner.
    const config = parseShipitConfig({ agent: {}, plugins: { repos: [] }, exports: { plugins: {} } });
    expect(config.warnings).toEqual([]);
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
        install: ["npm install", "npx prisma generate"],
      },
      compose: {
        file: "docker/local/dev/compose.yml",
        "docker-socket": true,
      },
    });
    expect(config.version).toBe(1);
    expect(config.agent).toEqual({
      install: ["npm install", "npx prisma generate"],
      depDirs: ["node_modules"],
      installInputs: null,
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

  // ---- release: block (docs/171 Phase 2) ----

  describe("release: block", () => {
    it("returns undefined when absent", () => {
      const config = parseShipitConfig({});
      expect(config.release).toBeUndefined();
    });

    it("parses a full valid release block", () => {
      const config = parseShipitConfig({
        release: {
          "version-source": "Cargo.toml",
          "tag-pattern": "v{version}",
          "prerelease-pattern": "v{version}-rc.{n}",
          notes: "github-generated",
          gate: "cargo test",
          mechanism: "tag-triggered",
          workflow: ".github/workflows/release.yml",
        },
      });
      expect(config.release).toEqual({
        versionSource: "Cargo.toml",
        tagPattern: "v{version}",
        prereleasePattern: "v{version}-rc.{n}",
        notes: "github-generated",
        gate: "cargo test",
        mechanism: "tag-triggered",
        workflow: ".github/workflows/release.yml",
      });
    });

    it("accepts a partial release block (only version-source)", () => {
      const config = parseShipitConfig({ release: { "version-source": "VERSION" } });
      expect(config.release?.versionSource).toBe("VERSION");
      expect(config.release?.tagPattern).toBeUndefined();
    });

    it("throws for non-object release block", () => {
      expect(() => parseShipitConfig({ release: "tag-only" })).toThrow(ShipitConfigError);
    });

    it("throws for unknown version-source value", () => {
      expect(() => parseShipitConfig({ release: { "version-source": "lerna.json" } })).toThrow(ShipitConfigError);
    });

    it("throws for tag-pattern without {version}", () => {
      expect(() => parseShipitConfig({ release: { "tag-pattern": "release-{tag}" } })).toThrow(ShipitConfigError);
    });

    it("throws for unknown mechanism", () => {
      expect(() => parseShipitConfig({ release: { mechanism: "auto-push" } })).toThrow(ShipitConfigError);
    });

    it("warns for unknown release keys", () => {
      const config = parseShipitConfig({ release: { "auto-publish": true } });
      expect(config.warnings.some((w) => w.includes("release.auto-publish"))).toBe(true);
    });

    it("accepts all valid version-source values", () => {
      for (const vs of ["package.json", "Cargo.toml", "pyproject.toml", "VERSION", "tag"]) {
        const config = parseShipitConfig({ release: { "version-source": vs } });
        expect(config.release?.versionSource).toBe(vs);
      }
    });

    it("accepts all valid mechanism values", () => {
      for (const mech of ["tag-triggered", "brokered", "release-branch"]) {
        const config = parseShipitConfig({ release: { mechanism: mech } });
        expect(config.release?.mechanism).toBe(mech);
      }
    });

    it("does not warn on the release top-level key", () => {
      const config = parseShipitConfig({ release: {} });
      expect(config.warnings).toEqual([]);
    });

    // ---- docs/214: release-branch mechanism + branch + version-source-path ----

    it("parses the release-branch mechanism with branch + version source", () => {
      const config = parseShipitConfig({
        release: { mechanism: "release-branch", branch: "stable", "version-source": "package.json" },
      });
      expect(config.release).toEqual({
        mechanism: "release-branch",
        branch: "stable",
        versionSource: "package.json",
      });
    });

    it("parses version-source-path for a monorepo", () => {
      const config = parseShipitConfig({
        release: { "version-source": "package.json", "version-source-path": "packages/api/package.json" },
      });
      expect(config.release?.versionSource).toBe("package.json");
      expect(config.release?.versionSourcePath).toBe("packages/api/package.json");
    });

    it("rejects release-branch with a tag version source", () => {
      expect(() =>
        parseShipitConfig({ release: { mechanism: "release-branch", "version-source": "tag" } }),
      ).toThrow(ShipitConfigError);
    });

    it("allows release-branch with no explicit version source (deferred to detection)", () => {
      const config = parseShipitConfig({ release: { mechanism: "release-branch", branch: "stable" } });
      expect(config.release?.mechanism).toBe("release-branch");
      expect(config.release?.versionSource).toBeUndefined();
    });

    it("throws for an empty branch", () => {
      expect(() => parseShipitConfig({ release: { branch: "   " } })).toThrow(ShipitConfigError);
    });

    it("throws for a non-string version-source-path", () => {
      expect(() => parseShipitConfig({ release: { "version-source-path": 3 } })).toThrow(ShipitConfigError);
    });

    it("does not warn on the branch / version-source-path keys", () => {
      const config = parseShipitConfig({
        release: { branch: "stable", "version-source-path": "packages/api/package.json" },
      });
      expect(config.warnings).toEqual([]);
    });
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
      "agent:\n  install: npm install\ncompose: docker-compose.yml\n",
    );
    const config = resolveShipitConfig(dir);
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

// ---------------------------------------------------------------------------
// docs/248 — `issues.trackers`
// ---------------------------------------------------------------------------

describe("issues.trackers", () => {
  const parse = (yaml: string) => parseShipitConfig(parseYaml(yaml));

  it("defaults to no declared trackers when the block is absent", () => {
    expect(parse("version: 1\n").issues.trackers).toEqual([]);
  });

  it("parses a github declaration into a named owner/repo destination", () => {
    const config = parse(`
issues:
  trackers:
    - kind: github
      repo: acme/planning
      name: planning
`);
    expect(config.issues.trackers).toEqual([
      { kind: "github", name: "planning", owner: "acme", repo: "planning" },
    ]);
    expect(config.warnings).toEqual([]);
  });

  // req 3 — both kinds are declared the same way; req 5 — a linear declaration
  // states the team key, which is also the prefix its issue keys carry.
  it("parses a linear declaration into a named team destination", () => {
    const config = parse(`
issues:
  trackers:
    - kind: linear
      team: SHI
      name: roadmap
`);
    expect(config.issues.trackers).toEqual([{ kind: "linear", name: "roadmap", team: "SHI" }]);
    expect(config.warnings).toEqual([]);
  });

  it("normalizes a lower-case linear team key so `SHI-304` still matches it", () => {
    const config = parse("issues:\n  trackers:\n    - kind: linear\n      team: shi\n      name: roadmap\n");
    expect(config.issues.trackers[0]).toMatchObject({ team: "SHI" });
  });

  // req 3 — a repository may declare two Linear trackers on different teams.
  it("accepts two linear declarations on different teams", () => {
    const config = parse(`
issues:
  trackers:
    - kind: linear
      team: SHI
      name: roadmap
    - kind: linear
      team: OPS
      name: ops
`);
    expect(config.issues.trackers).toEqual([
      { kind: "linear", name: "roadmap", team: "SHI" },
      { kind: "linear", name: "ops", team: "OPS" },
    ]);
  });

  // req 9a — `label` is the Issues tab's display text; `name` stays the address.
  // Restored under its original v0.3.1 spelling, so a config written in that
  // window parses rather than warning about an unknown key.
  it("parses an optional display label alongside the addressable name", () => {
    const config = parse(`
issues:
  trackers:
    - kind: github
      repo: acme/planning
      name: planning
      label: Planning
    - kind: linear
      team: SHI
      name: roadmap
      label: Product roadmap
`);
    expect(config.issues.trackers).toEqual([
      { kind: "github", name: "planning", label: "Planning", owner: "acme", repo: "planning" },
      { kind: "linear", name: "roadmap", label: "Product roadmap", team: "SHI" },
    ]);
    expect(config.warnings).toEqual([]);
  });

  it("omits `label` entirely when the declaration has none", () => {
    const config = parse("issues:\n  trackers:\n    - kind: github\n      repo: acme/planning\n      name: planning\n");
    expect(config.issues.trackers[0]).not.toHaveProperty("label");
  });

  // A cosmetic field must not cost a repository its tracker: a bad `label`
  // warns and falls back to the name, rather than dropping the declaration.
  it("warns and falls back to the name for a blank or non-string label", () => {
    for (const bad of ["label: '   '", "label: 42"]) {
      const config = parse(
        `issues:\n  trackers:\n    - kind: github\n      repo: acme/planning\n      name: planning\n      ${bad}\n`,
      );
      expect(config.issues.trackers).toEqual([
        { kind: "github", name: "planning", owner: "acme", repo: "planning" },
      ]);
      expect(config.warnings.some((w) => w.includes("trackers[0].label"))).toBe(true);
    }
  });

  it("preserves declaration order (it drives tab order)", () => {
    const config = parse(`
issues:
  trackers:
    - kind: github
      repo: acme/first
      name: first
    - kind: github
      repo: acme/second
      name: second
`);
    expect(config.issues.trackers.map((t) => t.name)).toEqual(["first", "second"]);
  });

  // The forward-compatibility contract in req 7: a config written against a
  // NEWER ShipIt that declares a tracker kind this build has never heard of must
  // degrade to "that tab doesn't appear", never to a failed session. Same for
  // every other malformed shape — a tracker declaration gates one tab, not the
  // container, so nothing here is allowed to throw.
  it.each([
    ["an unrecognized kind", "issues:\n  trackers:\n    - kind: jira\n      project: SHI\n      name: jira\n"],
    ["a missing kind", "issues:\n  trackers:\n    - repo: acme/planning\n      name: planning\n"],
    ["a github entry with no repo", "issues:\n  trackers:\n    - kind: github\n      name: planning\n"],
    ["a repo that isn't a slug", "issues:\n  trackers:\n    - kind: github\n      repo: planning\n      name: planning\n"],
    ["a linear entry with no team", "issues:\n  trackers:\n    - kind: linear\n      name: roadmap\n"],
    ["a linear team that isn't a key", "issues:\n  trackers:\n    - kind: linear\n      team: 'a b'\n      name: roadmap\n"],
    ["an entry with no name", "issues:\n  trackers:\n    - kind: github\n      repo: acme/planning\n"],
    ["a name that isn't writable as a reference", "issues:\n  trackers:\n    - kind: github\n      repo: acme/planning\n      name: 'my planning'\n"],
    ["a non-mapping entry", "issues:\n  trackers:\n    - acme/planning\n"],
    ["a non-list trackers", "issues:\n  trackers: acme/planning\n"],
    ["a non-mapping issues block", "issues: acme/planning\n"],
  ])("warns and skips %s rather than failing", (_label, yaml) => {
    const config = parse(yaml);
    expect(config.issues.trackers).toEqual([]);
    expect(config.warnings.length).toBeGreaterThan(0);
  });

  it("keeps the valid entries when one entry is unusable", () => {
    const config = parse(`
issues:
  trackers:
    - kind: some-future-tracker
      handle: whatever
      name: future
    - kind: github
      repo: acme/planning
      name: planning
`);
    expect(config.issues.trackers).toEqual([
      { kind: "github", name: "planning", owner: "acme", repo: "planning" },
    ]);
    expect(config.warnings.length).toBe(1);
  });

  // req 6 — `name` is unique within a repository. A duplicate is dropped rather
  // than shadowing, because a name resolving to two destinations is exactly the
  // ambiguity req 11 makes fail closed.
  it("drops a duplicate tracker name", () => {
    const config = parse(`
issues:
  trackers:
    - kind: github
      repo: acme/planning
      name: planning
    - kind: github
      repo: acme/other
      name: Planning
`);
    expect(config.issues.trackers).toHaveLength(1);
    expect(config.issues.trackers[0]).toMatchObject({ repo: "planning" });
    expect(config.warnings.some((w) => w.includes("duplicate tracker name"))).toBe(true);
  });

  // req 6, the other direction — a DESTINATION is declared at most once. Two
  // names for one repository are not an alias: `TrackerId` is the destination, so
  // both entries collapse onto one id and one tab shadows the other.
  it("drops a second declaration of a destination already declared", () => {
    const config = parse(`
issues:
  trackers:
    - kind: github
      repo: acme/planning
      name: planning
    - kind: github
      repo: acme/planning
      name: alias
`);
    expect(config.issues.trackers).toHaveLength(1);
    expect(config.issues.trackers[0]).toMatchObject({ name: "planning" });
    expect(config.warnings.some((w) => w.includes("already declared as `planning`"))).toBe(true);
  });

  // Destination identity is case-insensitive, like every other comparison of it —
  // GitHub treats `Acme/Planning` and `acme/planning` as the same repository.
  it("drops a duplicate destination written with different casing", () => {
    const config = parse(`
issues:
  trackers:
    - kind: github
      repo: acme/planning
      name: planning
    - kind: github
      repo: Acme/Planning
      name: alias
`);
    expect(config.issues.trackers).toHaveLength(1);
  });

  it("drops a second declaration of a Linear team already declared", () => {
    const config = parse(`
issues:
  trackers:
    - kind: linear
      team: SHI
      name: roadmap
    - kind: linear
      team: shi
      name: backlog
`);
    expect(config.issues.trackers).toHaveLength(1);
    expect(config.issues.trackers[0]).toMatchObject({ name: "roadmap" });
  });

  it("keeps two declarations that name genuinely different destinations", () => {
    const config = parse(`
issues:
  trackers:
    - kind: github
      repo: acme/planning
      name: planning
    - kind: linear
      team: SHI
      name: roadmap
`);
    expect(config.issues.trackers).toHaveLength(2);
  });

  it("warns about unknown keys inside an entry without dropping it", () => {
    const config = parse(
      "issues:\n  trackers:\n    - kind: github\n      repo: acme/planning\n      name: planning\n      colour: red\n",
    );
    expect(config.issues.trackers).toHaveLength(1);
    expect(config.warnings.some((w) => w.includes("colour"))).toBe(true);
  });

  it("does not warn about `issues` as an unknown top-level key", () => {
    const config = parse("issues:\n  trackers: []\n");
    expect(config.warnings).toEqual([]);
  });
});
